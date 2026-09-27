import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultAnalyzerRegistry, fingerprintRepositoryFiles, type AnalyzerRegistry, type RepositoryFile } from "@duo-director/analyzer";
import { fileRef, loadProjectTruth, nodeId, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkGraph } from "../check.js";
import { openNodeSqliteGraphStore } from "../store/node-sqlite/node-sqlite-graph-store.js";
import { applyGraphPlan } from "./apply.js";
import { buildGraphPlan } from "./builder.js";
import { EDGE_ENDPOINTS, isEdgeEndpointAllowed } from "./endpoints.js";
import { createTypeScriptModuleResolver } from "./resolve/typescript/typescript-module-resolver.js";
import type { GraphBuildPlan } from "./types.js";

let registry: AnalyzerRegistry;
const temps: string[] = [];
beforeAll(async () => {
  const r = await createDefaultAnalyzerRegistry();
  if (r.value === undefined) throw new Error("no registry");
  registry = r.value;
});
afterAll(() => {
  registry.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const PROJECT = { ".duo-project/project.yaml": "schema_version: 1\nname: t\n", "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }) };

/** Plans a graph for an in-memory project (no Git). */
async function planFor(files: Record<string, string>): Promise<GraphBuildPlan> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-builder-")));
  temps.push(root);
  for (const [f, c] of Object.entries({ ...PROJECT, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  const loaded = loadProjectTruth(root);
  if (loaded.value === undefined) throw new Error(JSON.stringify(loaded.diagnostics));
  const repoFiles = Object.keys({ ...PROJECT, ...files }).map((p) => ({ path: p as RepoPath, state: "untracked" as const })) satisfies RepositoryFile[];
  const { fingerprints } = await fingerprintRepositoryFiles(root, repoFiles);
  const analyses = fingerprints.flatMap((f) => {
    const analyzer = f.path.startsWith(".duo-project/") ? undefined : registry.analyzerFor(f.path);
    const r = analyzer?.analyze({ path: f.path, content: fs.readFileSync(path.join(root, f.path)) });
    return r?.value === undefined || analyzer === undefined ? [] : [{ analysis: r.value, analyzerVersion: analyzer.version }];
  });
  const indexed = new Set(fingerprints.map((f) => f.path).filter((p) => !p.startsWith(".duo-project/")));
  return buildGraphPlan({
    truth: loaded.value.truth, trace: loaded.value.trace, files: fingerprints, analyses,
    sourceText: (p) => fs.readFileSync(path.join(root, p), "utf8"),
    moduleResolver: createTypeScriptModuleResolver({ root, indexedFiles: indexed }),
  });
}
const calls = (plan: GraphBuildPlan) => plan.callResolutions.map((c) => [c.calleeText, c.status, c.reason ?? null, c.target?.symbol ?? null]);

describe("CALLS stay exact or are left out", () => {
  it("export * with the same name twice is ambiguous; an implementation beats a declaration file", async () => {
    const plan = await planFor({
      "a.ts": "export function x() {}", "b.ts": "export function x() {}",
      "impl.ts": "export function y() {}", "decl.d.ts": "export declare function y(): void;",
      "index.ts": 'export * from "./a"; export * from "./b"; export * from "./impl"; export * from "./decl";',
      "main.ts": 'import { x, y } from "./index"; export function main() { x(); y(); }',
    });
    expect(calls(plan)).toEqual([["x", "ambiguous", "export-ambiguous", null], ["y", "exact", null, "y"]]);
    expect(plan.edges.some((e) => e.type === "CALLS" && nodeId(e.to) === "sym:impl.ts#y")).toBe(true);
    expect(plan.diagnostics.filter((d) => d.code === "CALL_AMBIGUOUS")).toHaveLength(1);
  });

  it("does not guess this in static members or nested functions", async () => {
    const plan = await planFor({
      "c.ts": [
        "export class C {",
        "  static a() { this.b(); }",
        "  static b() {}",
        "  m() { const f = function () { this.n(); }; this.n(); }",
        "  n() {}",
        "}",
      ].join("\n"),
    });
    expect(calls(plan)).toEqual([
      ["this.b", "unresolved", "this-receiver-unknown", null],
      ["this.n", "unresolved", "this-not-member", null],
      ["this.n", "exact", null, "C.n"],
    ]);
  });

  it("does not call through type-only bindings or into non-callable exports", async () => {
    const plan = await planFor({
      "t.ts": "export function f() {} export default class K {} export const value = 1;",
      "u.ts": 'import type { f } from "./t"; import K, { value } from "./t"; export function g() { f(); K(); value(); new K(); }',
    });
    expect(calls(plan)).toEqual([
      ["f", "unresolved", "type-only-binding", null],
      ["K", "unresolved", "target-not-callable", null],
      ["value", "unresolved", "export-not-symbol", null],
      ["K", "exact", null, "K"],
    ]);
  });
});

describe("tests, supersedes and validation", () => {
  it("does not hide duplicate test names", async () => {
    const plan = await planFor({ "x.test.ts": 'import { it } from "vitest"; it("same", () => {}); it("same", () => {}); it("other", () => {});' });
    expect(plan.nodes.filter((n) => n.ref.type === "test").map((n) => nodeId(n.ref))).toEqual(["test:x.test.ts#other"]);
    expect(plan.diagnostics.filter((d) => d.code === "TEST_ID_CONFLICT")).toHaveLength(1);
  });

  it("drops SUPERSEDES edges on a cycle", async () => {
    const decision = (id: string, other: string) => `id: ${id}\ntitle: ${id}\nkind: decision\nstate: confirmed\nquestion: q${id}\nanswer: a\nsupersedes: ${other}\n`;
    const plan = await planFor({
      ".duo-project/decisions/D-1.yaml": decision("D-1", "D-2"), ".duo-project/decisions/D-2.yaml": decision("D-2", "D-1"),
      ".duo-project/decisions/D-3.yaml": decision("D-3", "D-2"),
    });
    expect(plan.edges.filter((e) => e.type === "SUPERSEDES").map((e) => `${nodeId(e.from)}>${nodeId(e.to)}`)).toEqual(["dec:D-3>dec:D-2"]);
  });

  it("never writes an invalid plan and rolls back a failed write", async () => {
    const plan = await planFor({ "a.ts": "export function a() {}" });
    const store = openNodeSqliteGraphStore({ path: ":memory:" }).value;
    if (store === undefined) throw new Error("no store");
    try {
      expect(applyGraphPlan(store, plan).diagnostics).toEqual([]);
      const before = store.counts();
      expect(applyGraphPlan(store, { ...plan, valid: false }).diagnostics.map((d) => d.code)[0]).toBe("GRAPH_WRITE_REFUSED");
      const broken = { ...plan, edges: [...plan.edges, { from: fileRef("a.ts" as RepoPath), type: "IMPORTS" as const, to: fileRef("missing.ts" as RepoPath) }] };
      expect(applyGraphPlan(store, broken).diagnostics.map((d) => d.code)).toEqual(["GRAPH_WRITE_REFUSED"]);
      expect(store.counts()).toEqual(before);
      expect(checkGraph(store)).toEqual([]);
      // graph.check() reports what the builder never plans.
      store.upsertEdges([{ from: fileRef("a.ts" as RepoPath), type: "CALLS", to: fileRef("a.ts" as RepoPath) }]);
      store.deleteEdges([{ from: fileRef("a.ts" as RepoPath), type: "CONTAINS", to: { type: "symbol", path: "a.ts" as RepoPath, symbol: "a" } }]);
      // a.ts and tsconfig.json are File nodes without fingerprints here.
      expect(checkGraph(store, { fingerprints: [] }).map((d) => d.message.slice(0, 12))).toEqual(["Invariant 2:", "Invariant 3:", "Invariant 3:", "Invariant 4:"]);
    } finally {
      store.close();
    }
  });

  it("endpoint matrix follows 04", () => {
    expect(Object.keys(EDGE_ENDPOINTS)).toHaveLength(10);
    expect(isEdgeEndpointAllowed("VALIDATED_BY", "requirement", "test")).toBe(true);
    expect(isEdgeEndpointAllowed("VALIDATED_BY", "test", "requirement")).toBe(false);
    expect(isEdgeEndpointAllowed("IMPLEMENTS", "requirement", "symbol")).toBe(false);
    expect(isEdgeEndpointAllowed("GOVERNS", "decision", "file")).toBe(true);
  });
});
