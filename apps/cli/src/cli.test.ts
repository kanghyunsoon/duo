import { readFileSync } from "node:fs";
import { CLI_NAME } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { run, COMMANDS, type Io } from "./cli.js";
import { VERSION } from "./version.js";

function fakeIo(cwd = "/nonexistent-duo-root"): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return {
    out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l), isTTY: false,
    prompt: () => Promise.resolve(undefined), readStdin: () => Promise.resolve(""), cwd: () => cwd, now: () => new Date(0), env: {},
  };
}

async function capture(argv: string[]) {
  const io = fakeIo();
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
    expect(JSON.parse(out[0] ?? "")).toEqual({
      name: CLI_NAME, version: VERSION,
      packages: ["@duo-director/core", "@duo-director/analyzer", "@duo-director/graph", "@duo-director/director", "@duo-director/integration"],
    });
  });

  it("prints help, rejects unknown commands and options, and names the Task of unimplemented commands", async () => {
    expect((await capture([])).out[0]).toContain("Usage: " + CLI_NAME + " <command>");
    expect((await capture(["deploy"])).code).toBe(1);
    expect((await capture(["status", "--bogus"])).code).toBe(1);
    for (const [command, task] of [["ui", "TASK-018"], ["install", "TASK-017"]] as const) {
      const r = await capture([command]);
      expect(r.code).toBe(1);
      expect(r.err[0]).toContain(task);
    }
    expect(COMMANDS).toEqual(expect.arrayContaining(["init", "status", "index", "context", "review", "trace", "impact", "decision", "stats"]));
  });

  it("--json wraps every result in a versioned envelope", async () => {
    const r = await capture(["review", "--fail-on", "sometimes", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out[0] ?? "")).toMatchObject({ format: "duo.cli.review/1", command: "review", ok: false, exitCode: 1, diagnostics: [{ code: "CLI_USAGE_INVALID" }] });
  });
});
