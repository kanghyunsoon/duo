import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { parseDuoAnnotations } from "./annotations.js";

const p = "a.ts" as RepoPath;

describe("parseDuoAnnotations", () => {
  it("reads a line comment", () => {
    expect(parseDuoAnnotations(p, "// duo: AUTH-03", 3, 5)).toEqual({
      annotations: [{ ids: ["AUTH-03"], location: { path: p, startLine: 3, startColumn: 8, endLine: 3, endColumn: 20 } }],
      diagnostics: [],
    });
  });

  it("reads each duo line of a block comment", () => {
    const r = parseDuoAnnotations(p, "/*\n * duo: AUTH-04, AUTH-05\n *   duo: GAME-42 */", 1, 1);
    expect(r.annotations).toEqual([
      { ids: ["AUTH-04", "AUTH-05"], location: { path: p, startLine: 2, startColumn: 4, endLine: 2, endColumn: 25 } },
      { ids: ["GAME-42"], location: { path: p, startLine: 3, startColumn: 6, endLine: 3, endColumn: 18 } },
    ]);
  });

  it("stops the ID list at free text and requires at least one ID", () => {
    expect(parseDuoAnnotations(p, "// duo: AUTH-07 — 로그인 보조, AUTH-08", 1, 1).annotations[0]?.ids).toEqual(["AUTH-07"]);
    const none = parseDuoAnnotations(p, "// duo: see docs", 1, 1);
    expect(none.annotations).toEqual([]);
    expect(none.diagnostics.map((d) => d.code)).toEqual(["DUO_ANNOTATION_INVALID"]);
  });

  it("ignores text where duo: does not start the comment line, and duplicate IDs", () => {
    expect(parseDuoAnnotations(p, "// see duo: AUTH-01", 1, 1)).toEqual({ annotations: [], diagnostics: [] });
    expect(parseDuoAnnotations(p, "//duo:AUTH-01,AUTH-01", 1, 1).annotations[0]?.ids).toEqual(["AUTH-01"]);
    expect(parseDuoAnnotations(p, "# duo: AUTH-01", 1, 1)).toEqual({ annotations: [], diagnostics: [] });
  });
});
