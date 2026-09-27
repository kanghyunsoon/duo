import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sliceSource } from "../location.js";
import { readSourceFile, readSourceSlice } from "../source-file.js";
import { loadProjectTruth } from "./project.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const fixture = (...p: string[]) => path.join(repo, "fixtures", ...p);
const problems = (r: ReturnType<typeof loadProjectTruth>) =>
  r.diagnostics.filter((d) => d.severity !== "info").map((d) => [d.code, d.source?.path, d.source?.startLine]);

describe("loadProjectTruth — valid project (fixtures/auth-app)", () => {
  const r = loadProjectTruth(fixture("auth-app"));
  const truth = r.value?.truth;

  it("AC-002-01 loads every Project Truth file without diagnostics", () => {
    expect(r.diagnostics).toEqual([]);
    expect(truth?.files).toEqual([
      ".duo-project/decisions/D-004.yaml",
      ".duo-project/decisions/proposals/P-20260927-k3f9qa.yaml",
      ".duo-project/intent/constraints.yaml",
      ".duo-project/intent/vision.md",
      ".duo-project/milestones/M1-issues.md",
      ".duo-project/milestones/M1.yaml",
      ".duo-project/project.yaml",
      ".duo-project/specs/auth.md",
    ]);
  });

  it("maps files to the domain model", () => {
    expect(truth?.config).toMatchObject({ schemaVersion: 1, name: "auth-app", currentMilestone: "M1", sources: { markdown: ["README.md"] } });
    expect(truth?.vision).toMatchObject({ status: "confirmed", owner: "human" });
    expect(truth?.requirements.map((q) => [q.id, q.status, q.location.startLine])).toEqual([["AUTH-01", "done", 3], ["AUTH-03", "planned", 17]]);
    expect(truth?.decisions[0]).toMatchObject({ id: "D-004", state: "confirmed", lock: { digest: "sha256:3f1c9a" }, forbids: { dependencies: ["express-session"] } });
    expect(truth?.constraints[0]).toMatchObject({
      id: "CON-001", enforcement: "warn",
      sources: [{ kind: "external", path: "README.md", hash: "sha256:5b1e0c", section: "Scope" }],
    });
    expect(truth?.proposals[0]).toMatchObject({ id: "P-20260927-k3f9qa", state: "proposed", proposedBy: "claude-code" });
    expect(truth?.issues.map((i) => [i.id, i.milestone, i.acceptance.map((a) => a.id)])).toEqual([
      ["GAME-41", "M1", ["AC-041-01"]],
      ["GAME-42", "M1", ["AC-042-01"]],
    ]);
    expect(truth?.milestones[0]).toMatchObject({ id: "M1", issues: ["GAME-41", "GAME-42"] });
  });

  it("gives YAML and Markdown definitions the same SourceLocation contract (start and end)", () => {
    // Line 19 is '  digest: "sha256:3f1c9a"' (25 characters): the exclusive end column is 26.
    expect(truth?.decisions[0]?.location).toEqual({ path: ".duo-project/decisions/D-004.yaml", startLine: 1, startColumn: 1, endLine: 19, endColumn: 26 });
    expect(truth?.constraints[0]?.location).toMatchObject({ path: ".duo-project/intent/constraints.yaml", startLine: 2, endLine: 12 });
    expect(truth?.milestones[0]?.location).toMatchObject({ startLine: 1, endLine: 4 });
    expect(truth?.requirements[0]?.location).toMatchObject({ startLine: 3, startColumn: 1, endLine: 17, endColumn: 1 });
    // Every definition location slices its canonical source exactly (T09.1).
    const root = fixture("auth-app");
    for (const d of [...(truth?.requirements ?? []), ...(truth?.decisions ?? []), ...(truth?.issues ?? []), ...(truth?.milestones ?? []), ...(truth?.constraints ?? [])]) {
      expect(readSourceSlice(root, d.location).diagnostics, d.id).toEqual([]);
    }
    expect(readSourceSlice(root, truth?.requirements[0]?.location ?? { path: "" }).value).toMatch(/^## AUTH-01 [^\n]*\n[\s\S]*\n$/u);
  });

  it("derives trace links", () => {
    expect(r.value?.trace.links.map((l) => `${l.from.id} ${l.relation} ${l.to.id}`)).toEqual([
      "D-004 GOVERNS AUTH-01",
      "D-004 GOVERNS AUTH-03",
      "D-004 GOVERNS GAME-42",
      "AUTH-03 REQUIRES AUTH-01",
      "M1 REQUIRES AUTH-01",
      "M1 REQUIRES AUTH-03",
      "AUTH-01 TRACKED_BY GAME-41",
      "AUTH-03 TRACKED_BY GAME-42",
    ]);
  });
});

describe("loadProjectTruth — Windows-style paths and CRLF (fixtures/core/windows-paths)", () => {
  const r = loadProjectTruth(fixture("core", "windows-paths"));
  const truth = r.value?.truth;

  it("AC-002-05 stores only repository-relative POSIX paths", () => {
    expect(r.diagnostics).toEqual([]);
    expect(truth?.config.sources.markdown).toEqual(["docs/legacy/spec.md"]);
    expect(truth?.requirements[0]?.implements.paths).toEqual(["src/auth/**"]);
    expect(truth?.requirements[0]?.sources).toEqual([{ kind: "external", path: "docs/legacy/spec.md", hash: "sha256:abc", section: "Login" }]);
    expect(truth?.decisions[0]?.governs.paths).toEqual(["src/auth/"]);
    expect(truth?.decisions[0]?.evidence[0]?.path).toBe("src/auth/AuthService.ts");
    expect(truth?.files.every((f) => !f.includes("\\"))).toBe(true);
    // The last section runs to the end of the file: 11 lines and a final CRLF, so the end is line 12, column 1.
    expect(truth?.requirements[0]?.location).toMatchObject({ path: ".duo-project/specs/auth.md", startLine: 1, startColumn: 1, endLine: 12, endColumn: 1 });
    const text = readSourceFile(fixture("core", "windows-paths"), ".duo-project/specs/auth.md").value ?? "";
    expect(sliceSource(text, truth?.requirements[0]?.location ?? { path: "" }).value).toBe(text);
  });
});

describe("loadProjectTruth — invalid fixtures (fixtures/core/invalid)", () => {
  const cases: [string, [string, string, number][]][] = [
    ["malformed-yaml", [["YAML_SYNTAX_ERROR", ".duo-project/decisions/D-001.yaml", 8]]],
    ["malformed-metadata-block", [["YAML_SYNTAX_ERROR", ".duo-project/specs/auth.md", 7]]],
    ["duplicate-id", [["DUPLICATE_ID", ".duo-project/specs/b.md", 1]]],
    ["broken-reference", [["BROKEN_REFERENCE", ".duo-project/milestones/M1.yaml", 4]]],
    ["unsupported-schema-version", [["UNSUPPORTED_SCHEMA_VERSION", ".duo-project/project.yaml", 1]]],
    ["unknown-property", [["SCHEMA_UNKNOWN_PROPERTY", ".duo-project/specs/auth.md", 5]]],
    ["missing-required-property", [["SCHEMA_MISSING_PROPERTY", ".duo-project/decisions/D-001.yaml", 1]]],
    ["invalid-id", [["INVALID_ID", ".duo-project/decisions/D-001.yaml", 1]]],
    ["yaml-alias", [["YAML_ALIAS_NOT_ALLOWED", ".duo-project/decisions/D-001.yaml", 4], ["YAML_ALIAS_NOT_ALLOWED", ".duo-project/decisions/D-001.yaml", 5]]],
    ["path-outside-repository", [["PATH_OUTSIDE_REPOSITORY", ".duo-project/specs/auth.md", 6]]],
  ];

  it("covers every fixture directory", () => {
    expect(fs.readdirSync(fixture("core", "invalid")).sort()).toEqual(cases.map(([name]) => name).sort());
  });

  it.each(cases)("AC-002-02 %s fails with file:line diagnostics", (name, expected) => {
    expect(problems(loadProjectTruth(fixture("core", "invalid", name)))).toEqual(expected);
  });

  it("returns no Project Truth for an unsupported schema version", () => {
    expect(loadProjectTruth(fixture("core", "invalid", "unsupported-schema-version")).value).toBeUndefined();
  });

  it("reports a missing project.yaml without throwing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "duo-empty-"));
    try {
      expect(problems(loadProjectTruth(empty))).toEqual([["PROJECT_FILE_MISSING", ".duo-project/project.yaml", undefined]]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
