import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pnpm, pnpmInvocation } from "../../scripts/release/common.mjs";

const directories: string[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo pnpm invocation-"));
  directories.push(dir);
  const probe = path.join(dir, "pnpm-probe.cjs");
  fs.writeFileSync(probe, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return { dir, probe };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release pnpm invocation", () => {
  it.each(["js", "cjs", "mjs", "CJS"])("selects Node for .%s on all supported platforms", (extension) => {
    const entry = "/tools with spaces/pnpm/bin/pnpm." + extension;
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(pnpmInvocation(entry, () => true, platform, ["two words"])).toEqual({ command: process.execPath, args: [entry, "two words"], shell: false });
    }
  });

  it.each([
    ["win32", "C:\\tools with spaces\\pnpm.exe"],
    ["linux", "/tools with spaces/pnpm"],
    ["darwin", "/tools with spaces/pnpm"],
  ] as const)("selects the standalone binary directly on %s", (platform, entry) => {
    expect(pnpmInvocation(entry, () => true, platform, ["two words"])).toEqual({ command: entry, args: ["two words"], shell: false });
  });

  it.each(["cmd", "bat"])("escapes Windows .%s shim arguments for both cmd parsing passes", (extension) => {
    const entry = "C:\\tools with spaces\\pnpm." + extension;
    const args = ["two words", "literal&echo DUO_ARG_INJECTION"];
    const escapedCommand = "C:\\tools^ with^ spaces\\pnpm." + extension;
    expect(pnpmInvocation(entry, () => true, "win32", args)).toEqual({
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `"${escapedCommand} ^^^"two^^^ words^^^" ^^^"literal^^^&echo^^^ DUO_ARG_INJECTION^^^""`],
      shell: false,
      windowsVerbatimArguments: true,
    });
    expect(args).toEqual(["two words", "literal&echo DUO_ARG_INJECTION"]);
    for (const platform of ["linux", "darwin"] as const) {
      expect(pnpmInvocation(entry, () => true, platform, args)).toEqual({ command: entry, args, shell: false });
    }
  });

  it.each(["\r", "\n", "\0"])("rejects shim argument control character %j before spawning", (character) => {
    expect(() => pnpmInvocation("C:\\tools\\pnpm.cmd", () => true, "win32", ["literal" + character + "echo DUO_ARG_INJECTION"]))
      .toThrow("Windows pnpm shims cannot pass NUL or line breaks literally");
  });

  it.each(["win32", "linux", "darwin"] as const)("preserves PATH fallback on %s", (platform) => {
    const args = ["build"];
    const fallback = { command: "pnpm", args, shell: platform === "win32" };
    expect(pnpmInvocation(undefined, () => true, platform, args)).toEqual(fallback);
    expect(pnpmInvocation("/tools/npm-cli.js", () => true, platform, args)).toEqual(fallback);
    expect(pnpmInvocation("/missing/pnpm.cjs", () => false, platform, args)).toEqual(fallback);
  });

  it.each(["js", "cjs", "mjs"])("runs a .%s entry point through Node", (extension) => {
    const { dir } = fixture();
    const entry = path.join(dir, "pnpm." + extension);
    fs.writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    vi.stubEnv("npm_execpath", entry);

    const result = pnpm(["build", "two words"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["build", "two words"]);
  });

  it("executes a standalone binary directly, including paths and arguments with spaces", () => {
    const { dir, probe } = fixture();
    const binary = path.join(dir, process.platform === "win32" ? "pnpm.exe" : "pnpm");
    if (process.platform === "win32") fs.copyFileSync(process.execPath, binary);
    else fs.symlinkSync(process.execPath, binary);
    vi.stubEnv("npm_execpath", binary);

    const result = pnpm([probe, "build", "two words"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["build", "two words"]);
  });

  it("falls back to the pnpm command on PATH", () => {
    const { dir } = fixture();
    const shim = path.join(dir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    fs.writeFileSync(shim, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0pnpm-probe.cjs" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/pnpm-probe.cjs" "$@"\n`, { mode: 0o755 });
    vi.stubEnv("npm_execpath", undefined);
    vi.stubEnv("PATH", dir + path.delimiter + (process.env.PATH ?? ""));

    const result = pnpm(["build"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["build"]);
  });

  it.skipIf(process.platform !== "win32").each(["cmd", "bat"])("preserves literal arguments through a Windows .%s shim", (extension) => {
    const { dir } = fixture();
    const shim = path.join(dir, "pnpm." + extension);
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0pnpm-probe.cjs" %*\r\n`);
    vi.stubEnv("npm_execpath", shim);

    const args = ["build", "two words", "", 'embedded"quote', "backslash\\", 'slashes\\\\"quote',
      "literal&echo DUO_ARG_INJECTION", "literal|echo DUO_PIPE_INJECTION", "caret^value", "(parentheses)",
      "%DUO_ARG_VALUE%", "!DUO_ARG_VALUE!", "100%", "literal>DUO_ARG_REDIRECT", "literal<DUO_ARG_REDIRECT"];
    const result = pnpm(args, { cwd: dir, env: { ...process.env, DUO_ARG_VALUE: "EXPANSION_IS_NOT_LITERAL" } });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(path.join(dir, "DUO_ARG_REDIRECT"))).toBe(false);
  });

  it.skipIf(process.platform !== "win32").each(["cmd", "bat"])("preserves nonzero exit and stderr from a Windows .%s shim", (extension) => {
    const { dir, probe } = fixture();
    const shim = path.join(dir, "pnpm." + extension);
    fs.writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write("pnpm shim failure\\n");\nprocess.exitCode = 23;\n');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0pnpm-probe.cjs" %*\r\n`);
    vi.stubEnv("npm_execpath", shim);

    const args = ["two words", "literal&echo DUO_ARG_INJECTION"];
    const result = pnpm(args, { cwd: dir });
    expect(result.code).toBe(23);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr).toBe("pnpm shim failure\n");
  });
});
