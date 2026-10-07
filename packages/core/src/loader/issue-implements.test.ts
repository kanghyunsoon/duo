/**
 * H-78 (T45): an Issue may declare the repository path scope it implements (implements.paths), with the same
 * pattern rules as a Requirement's. Paths only; the schema stays strict.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProjectTruth } from "./project.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function load(block: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue-impl-"));
  temps.push(root);
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  w(".duo-project/project.yaml", "schema_version: 1\nname: t45\n");
  w(".duo-project/specs/tasks.md", ["# Tasks", "", "## TASK-015 Desktop shell", "", "```duo", "type: issue", "status: todo", ...block.split("\n").filter((l) => l !== ""), "```", "", "Build the desktop shell. Compare with apps/legacy/main.ts.", ""].join("\n"));
  const r = loadProjectTruth(root);
  return { issue: r.value?.truth.issues.find((i) => i.id === "TASK-015"), codes: r.diagnostics.map((d) => d.code) };
}

describe("Issue.implements.paths (H-78)", () => {
  it("is optional: an Issue without it has an empty scope and no diagnostic", () => {
    const r = load("");
    expect(r.codes).toEqual([]);
    expect(r.issue?.implements).toEqual({ paths: [] });
  });
  it("reads repository patterns with the Requirement normalization (separators, ./, //)", () => {
    const r = load("implements:\n  paths: [\"apps/desktop/**\", \"apps\\\\shared\\\\ipc.ts\", \"./apps//cli/*.ts\"]");
    expect(r.codes).toEqual([]);
    expect(r.issue?.implements.paths).toEqual(["apps/desktop/**", "apps/shared/ipc.ts", "apps/cli/*.ts"]);
  });
  it("an absolute or outside pattern is a diagnostic, as for a Requirement", () => {
    expect(load("implements:\n  paths: [\"../secrets/**\"]").codes).toContain("PATH_OUTSIDE_REPOSITORY");
    expect(load("implements:\n  paths: [\"C:\\\\src\\\\**\"]").codes).toContain("INVALID_PATH");
  });
  it("only paths: implements.symbols and other unknown fields stay schema errors (the Issue is not read)", () => {
    const sym = load("implements:\n  symbols: [Shell.start]");
    expect(sym.codes).toContain("SCHEMA_UNKNOWN_PROPERTY");
    expect(sym.issue).toBeUndefined();
    expect(load("paths: [\"apps/desktop/**\"]").codes).toContain("SCHEMA_UNKNOWN_PROPERTY");
  });
  it("a path in the body is not a scope", () => {
    expect(load("").issue?.implements.paths).toEqual([]);
  });
});
