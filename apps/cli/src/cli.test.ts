import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { run, COMMANDS, type Io } from "./cli.js";
import { VERSION } from "./version.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../../fixtures/context/app", import.meta.url));

function fakeIo(cwd = "/nonexistent-duo-root"): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return {
    out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l), isTTY: false,
    prompt: () => Promise.resolve(undefined), readStdin: () => Promise.resolve(""), cwd: () => cwd, now: () => new Date(0), env: {},
  };
}

async function capture(argv: string[], cwd?: string) {
  const io = fakeIo(cwd);
  const code = await run(argv, io);
  return { code, out: io.out_, err: io.err_ };
}

describe("CLI entry (T15)", () => {
  it("AC-001-03 --version prints the package version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(await capture(["--version"])).toEqual({ code: 0, out: [CLI_NAME + " " + VERSION], err: [] });
  });

  it("AC-001-03 --version --json resolves every runtime workspace package", async () => {
    const { code, out } = await capture(["--version", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toMatchObject({
      name: CLI_NAME, version: VERSION,
      packages: ["@duo-director/core", "@duo-director/analyzer", "@duo-director/graph", "@duo-director/director", "@duo-director/integration"],
      graphSchemaVersion: expect.any(Number), projectSchemaVersions: [1], node: process.version,
    });
  });

  it("T17.1 the Node.js gate accepts the engines range and names the problem below it", async () => {
    const { nodeVersionProblem } = await import("./node-version.js");
    expect(nodeVersionProblem("v24.15.0", ">=24.15.0")).toBeUndefined();
    expect(nodeVersionProblem("v25.0.0", ">=24.15.0")).toBeUndefined();
    expect(nodeVersionProblem("v24.14.9", ">=24.15.0")).toMatch(/requires Node\.js >=24\.15\.0 \(this is v24\.14\.9\)/u);
    expect(nodeVersionProblem("v22.12.0", ">=24.15.0")).toMatch(/does not bundle Node\.js/u);
  });

  it("prints help and rejects unknown commands and options", async () => {
    expect((await capture([])).out[0]).toContain("Usage: " + CLI_NAME + " <command>");
    expect((await capture(["deploy"])).code).toBe(1);
    expect((await capture(["status", "--bogus"])).code).toBe(1);
    expect(COMMANDS).toEqual(expect.arrayContaining(["init", "status", "index", "context", "review", "trace", "impact", "decision", "stats", "ui"]));
  });

  it("parses valued global options before and after the command", async () => {
    const variants = [
      ["--root", FIXTURE, "status", "--json"],
      ["status", "--root", FIXTURE, "--json"],
      [`--root=${FIXTURE}`, "status", "--json"],
    ];

    for (const argv of variants) {
      const result = await capture(argv, REPO_ROOT);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out[0] ?? "")).toMatchObject({
        command: "status",
        ok: true,
        exitCode: 0,
        result: { project: { name: "context-app" } },
      });
    }

    // #106: "." is the value of --root, not the command; both placements must give the same result.
    const exactRegression = await capture(["--root", ".", "status", "--json"], REPO_ROOT);
    const commandFirst = await capture(["status", "--root", ".", "--json"], REPO_ROOT);
    expect(exactRegression.err.join("\n")).not.toContain("unknown command");
    expect(exactRegression.code).toBe(commandFirst.code);
    expect(exactRegression.out).toEqual(commandFirst.out);
    expect(JSON.parse(exactRegression.out[0] ?? "")).toMatchObject({ command: "status", exitCode: exactRegression.code });
  });

  it("parses locale and boolean global options on either side of the command", async () => {
    const before = await capture(["--locale", "ko", "--json", "--root", FIXTURE, "status"]);
    const after = await capture(["status", "--root", FIXTURE, "--locale", "ko", "--json"]);

    expect(before.code).toBe(0);
    expect(after.code).toBe(0);
    expect(before.out).toEqual(after.out);

    const localized = await capture(["--locale", "ko", "--root", FIXTURE, "status"]);
    expect(localized.code).toBe(0);
    expect(localized.out.join("\n")).toContain("대기 중 decision:");
    expect(localized.out.join("\n")).not.toContain("Pending decisions:");
  });

  it("keeps command-specific options strict during command discovery", async () => {
    const after = await capture(["status", "--budget", "100"]);
    const before = await capture(["--budget", "100", "status"]);

    expect(after.code).toBe(1);
    expect(before.code).toBe(1);
    expect(after.err.join("\n")).toContain("Unknown option '--budget'");
    expect(before.err.join("\n")).toContain("Unknown option '--budget'");
  });

  it("--json wraps every result in a versioned envelope", async () => {
    const r = await capture(["review", "--fail-on", "sometimes", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out[0] ?? "")).toMatchObject({ format: "duo.cli.review/1", command: "review", ok: false, exitCode: 1, diagnostics: [{ code: "CLI_USAGE_INVALID" }] });
  });
});
