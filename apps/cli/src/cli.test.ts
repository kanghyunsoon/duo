import { readFileSync } from "node:fs";
import { CLI_NAME } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { run, PLANNED_COMMANDS } from "./cli.js";
import { VERSION } from "./version.js";

function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe("CLI skeleton", () => {
  it("AC-001-03 --version prints the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(capture(["--version"])).toEqual({ code: 0, out: [`${CLI_NAME} ${VERSION}`], err: [] });
  });

  it("AC-001-03 --version --json resolves every runtime workspace package", () => {
    const { code, out } = capture(["--version", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "")).toEqual({
      name: CLI_NAME,
      version: VERSION,
      packages: ["@duo-director/core", "@duo-director/analyzer", "@duo-director/graph", "@duo-director/director", "@duo-director/integration"],
    });
  });

  it("prints help without a command", () => {
    const { code, out } = capture([]);
    expect(code).toBe(0);
    expect(out[0]).toContain(`Usage: ${CLI_NAME} <command>`);
  });

  it("rejects planned commands until they are implemented", () => {
    for (const command of PLANNED_COMMANDS) {
      const { code, err } = capture([command]);
      expect(code).toBe(1);
      expect(err[0]).toContain("not implemented yet");
    }
  });

  it("rejects unknown commands", () => {
    expect(capture(["deploy"]).code).toBe(1);
  });
});
