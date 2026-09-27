import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, countingRegistry, edge, edgeCount, invariantProblems, makeRepo, memoryStore, nodeExists, type CountingRegistry, type TestRepo } from "./testing.js";
import type { IndexResult } from "./types.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** A small window so that the rolling-window test needs only a few commits (the policy is the same as 500). */
const WINDOW = 6;
const temps: string[] = [];
let base: AnalyzerRegistry;
let counting: CountingRegistry;
let repo: TestRepo;
let store: GraphStore;
const report: Record<string, unknown>[] = [];

beforeAll(async () => {
  base = await baseRegistry();
  counting = countingRegistry(base);
  repo = makeRepo(temps);
  for (const message of ["APP-10 tweak", "UTF-8 fix", "more"]) {
    for (const f of ["src/auth/login.ts", "src/app.ts"]) fs.appendFileSync(`${repo.root}/${f}`, `// ${message}\n`);
    repo.git("commit", "-q", "-am", message);
  }
  store = memoryStore();
});
afterAll(() => {
  store?.close();
  base?.dispose();
  if (process.env.DUO_T08_REPORT !== undefined) fs.writeFileSync(process.env.DUO_T08_REPORT, JSON.stringify(report, null, 2));
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const fresh = (r: IndexResult, p: string) => r.freshness.find((f) => f.path === p);

/** Runs the Indexer and checks invariant 5 against a clean full rebuild of the same state. */
async function step(name: string, expectedMode: "full" | "incremental" = "incremental"): Promise<IndexResult> {
  counting.parses = 0;
  const r = await indexRepository(repo.root, { store, registry: counting.registry, historyWindow: WINDOW });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  expect(r.value.mode).toBe(expectedMode);
  expect(counting.parses).toBe(r.value.metrics.files.analyzed);
  const oracle = await cleanRebuild(repo.root, base, WINDOW);
  expect(dumpGraph(store)).toEqual(oracle);
  expect(invariantProblems(store, repo.root)).toEqual([]);
  const m = r.value.metrics;
  report.push({
    step: name, mode: m.mode, analyzed: m.files.analyzed, reused: m.files.analysisReused,
    files: `~${m.files.changed} +${m.files.added} -${m.files.deleted}`,
    modules: `${m.resolution.modulesRecomputed}/${m.resolution.modulesRecomputed + m.resolution.modulesReused} (${m.resolution.filesModulesRecomputed} files)`,
    calls: `${m.resolution.callsRecomputed}/${m.resolution.callsRecomputed + m.resolution.callsReused} (${m.resolution.filesCallsRecomputed} files)`,
    history: m.history.recomputed,
    graph: `scopes ${m.graph.scopesChanged}/${m.graph.scopes} nodes +${m.graph.nodesAdded} ~${m.graph.nodesUpdated} -${m.graph.nodesRemoved} edges +${m.graph.edgesAdded} ~${m.graph.edgesUpdated} -${m.graph.edgesRemoved}`,
  });
  return r.value;
}

describe("AC-008-01 incremental result == clean full rebuild, mutation by mutation", () => {
  it("initial run without state is a full rebuild", async () => {
    const r = await step("initial", "full");
    expect(r.fullRebuildReason).toBe("no-state");
    expect(r.metrics.files.analysisReused).toBe(0);
    expect(r.freshness.every((f) => f.file === "unknown")).toBe(true);
  });

  it("AC-008-02 an unchanged rerun parses nothing and writes nothing", async () => {
    const revision = store.readMeta("graph_revision");
    const r = await step("no change");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(r.metrics.resolution.modulesRecomputed + r.metrics.resolution.callsRecomputed).toBe(0);
    expect(r.metrics.graph.written).toBe(false);
    expect(store.readMeta("graph_revision")).toBe(revision);
  });

  it("source file body changed", async () => {
    repo.edit("src/shared/format.ts", "return String(n);", "return String(n).trim();");
    const r = await step("source body changed");
    expect(r.metrics.files.analyzed).toBe(1);
    expect(fresh(r, "src/shared/format.ts")).toMatchObject({ file: "changed", analysis: "stale-content", modules: "stale-source", calls: "stale-source" });
    expect(fresh(r, "src/app.ts")).toMatchObject({ file: "fresh", analysis: "fresh", modules: "fresh", calls: "stale-dependency" });
    expect(fresh(r, "src/chain/f.ts")).toMatchObject({ analysis: "fresh", modules: "fresh", calls: "fresh" });
  });

  it("symbol added", async () => {
    repo.write("src/shared/format.ts", `${repo.read("src/shared/format.ts")}\nexport function formatAll(values: number[]): string {\n  return values.map(format).join(",");\n}\n`);
    await step("symbol added");
    expect(nodeExists(store, "sym:src/shared/format.ts#formatAll")).toBe(true);
  });

  it("symbol deleted", async () => {
    repo.edit("src/auth/login.ts", "// duo: NOPE-99\nexport function logout(): void {}\n", "");
    await step("symbol deleted");
    expect(nodeExists(store, "sym:src/auth/login.ts#logout")).toBe(false);
  });

  it("symbol renamed (a new identity; no rename is inferred)", async () => {
    repo.edit("src/util/index.ts", "export function util()", "export function utility()");
    await step("symbol renamed");
    expect(nodeExists(store, "sym:src/util/index.ts#util")).toBe(false);
    expect(nodeExists(store, "sym:src/util/index.ts#utility")).toBe(true);
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/util/index.ts#utility")).toBeUndefined();
  });

  it("new import", async () => {
    repo.edit("src/app.ts", 'import { missing } from "./missing.js";\n', 'import { missing } from "./missing.js";\nimport { legacy } from "./legacy.js";\nimport { format as fmt } from "#fmt";\n');
    repo.edit("src/app.ts", "  missing();\n}", "  missing();\n  legacy();\n  fmt(9);\n}");
    const r = await step("new import");
    expect(fresh(r, "src/app.ts")).toMatchObject({ analysis: "stale-content", modules: "stale-source" });
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/legacy.js")).toBeDefined();
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/legacy.js#legacy")).toBeDefined();
  });

  it("removed import", async () => {
    repo.edit("src/app.ts", 'import { deep as nearDeep } from "./chain/near.js";\n', "");
    repo.edit("src/app.ts", "  nearDeep();\n", "");
    await step("removed import");
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/chain/near.ts")).toBeUndefined();
  });

  it("target export changed", async () => {
    repo.edit("src/auth/session.ts", "export default function createSession", "export function createSession");
    const r = await step("target export changed");
    expect(fresh(r, "src/app.ts")).toMatchObject({ analysis: "fresh", calls: "stale-dependency" });
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/auth/session.ts#createSession")).toBeUndefined();
  });

  it("same-file call change", async () => {
    repo.edit("src/auth/login.ts", "  return validate(user);", "  return user.length > 0;");
    await step("same-file call change");
    expect(edge(store, "sym:src/auth/login.ts#login", "CALLS", "sym:src/auth/login.ts#validate")).toBeUndefined();
  });

  it("imported call change", async () => {
    repo.edit("src/app.ts", "  format(1);\n", "");
    await step("imported call change");
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/shared/format.ts#format")).toBeUndefined();
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/shared/format.ts")).toBeDefined();
  });

  it("re-export target change", async () => {
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/auth/login.ts#login")?.metadata.callSites).toBe(3);
    repo.edit("src/auth/index.ts", 'export { login } from "./login.js";', 'export { login } from "./session.js";');
    const r = await step("re-export target change");
    expect(fresh(r, "src/app.ts")).toMatchObject({ analysis: "fresh", calls: "stale-dependency" });
    // Only the direct import of login.ts is left; the two calls through auth/index.ts no longer resolve.
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/auth/login.ts#login")?.metadata.callSites).toBe(1);
  });

  it("file added (an unchanged importer now resolves)", async () => {
    repo.write("src/missing.ts", "export function missing(): void {}\n");
    repo.write("src/new-shared/format.ts", "export function format(n: number): string {\n  return `#${n}`;\n}\n");
    const r = await step("file added");
    expect(r.metrics.files.analyzed).toBe(2);
    expect(fresh(r, "src/app.ts")).toMatchObject({ analysis: "fresh", modules: "stale-file-set", calls: "stale-modules" });
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/missing.ts")).toBeDefined();
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/missing.ts#missing")).toBeDefined();
  });

  it("file deleted", async () => {
    repo.remove("src/util/index.ts");
    const r = await step("file deleted");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(fresh(r, "src/util/index.ts")).toMatchObject({ file: "deleted" });
    expect(nodeExists(store, "file:src/util/index.ts")).toBe(false);
  });

  it("file renamed (deleted + added, identity not carried over)", async () => {
    repo.rename("src/legacy.js", "src/legacy-old.js");
    const r = await step("file renamed");
    expect(r.metrics.files.analyzed).toBe(1);
    expect(nodeExists(store, "file:src/legacy.js")).toBe(false);
    expect(nodeExists(store, "sym:src/legacy-old.js#legacy")).toBe(true);
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/legacy.js")).toBeUndefined();
  });

  it("test added", async () => {
    repo.edit("test/app.test.ts", '  // duo: APP-02\n  it("keeps the session"', '  it("formats", () => {\n    format(3);\n  });\n\n  // duo: APP-02\n  it("keeps the session"');
    await step("test added");
    expect(edge(store, "sym:src/shared/format.ts#format", "VALIDATED_BY", "test:test/app.test.ts#App > formats")).toBeDefined();
  });

  it("test removed", async () => {
    repo.edit("test/app.test.ts", '  it("logs in", () => {\n    login("x");\n    helper();\n  });\n\n', "");
    await step("test removed");
    expect(nodeExists(store, "test:test/app.test.ts#App > logs in")).toBe(false);
  });

  it("annotation added", async () => {
    repo.edit("src/shared/format.ts", "export function format(", "// duo: APP-02\nexport function format(");
    await step("annotation added");
    expect(edge(store, "sym:src/shared/format.ts#format", "IMPLEMENTS", "req:APP-02")).toBeDefined();
  });

  it("annotation removed", async () => {
    repo.edit("src/app.ts", "// duo: APP-02\n", "");
    await step("annotation removed");
    expect(edge(store, "file:src/app.ts", "IMPLEMENTS", "req:APP-02")).toBeUndefined();
  });

  it("Requirement changed (no source is parsed)", async () => {
    repo.edit(".duo-project/specs/app.md", 'paths: ["src/auth/session.ts"]', 'paths: ["src/auth/login.ts"]');
    const r = await step("Requirement changed");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(r.metrics.resolution.modulesRecomputed + r.metrics.resolution.callsRecomputed).toBe(0);
    expect(edge(store, "file:src/auth/login.ts", "IMPLEMENTS", "req:APP-02")).toBeDefined();
    expect(edge(store, "file:src/auth/session.ts", "IMPLEMENTS", "req:APP-02")).toBeUndefined();
  });

  it("Decision changed (no source is parsed)", async () => {
    repo.edit(".duo-project/decisions/D-001.yaml", 'paths: ["src/auth/**"]', 'paths: ["src/shared/**"]');
    const r = await step("Decision changed");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(edge(store, "dec:D-001", "GOVERNS", "file:src/shared/format.ts")).toBeDefined();
    expect(edge(store, "dec:D-001", "GOVERNS", "file:src/auth/login.ts")).toBeUndefined();
  });

  it("SUPERSEDES changed", async () => {
    repo.write(".duo-project/decisions/D-003.yaml", "id: D-003\ntitle: Passkey only\nkind: decision\nstate: proposed\nquestion: login_mechanism\nanswer: passkey-only\ngoverns:\n  requirements: [APP-01]\nsupersedes: D-002\n");
    const r = await step("SUPERSEDES changed");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(edge(store, "dec:D-003", "SUPERSEDES", "dec:D-002")).toBeDefined();
  });

  it("tsconfig paths changed (no source line changed, IMPORTS and CALLS follow the config)", async () => {
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/new-shared/format.ts")).toBeUndefined();
    repo.edit("tsconfig.json", '"./src/shared/*"', '"./src/new-shared/*"');
    const r = await step("tsconfig paths changed");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(fresh(r, "src/app.ts")).toMatchObject({ analysis: "fresh", modules: "stale-config", calls: "stale-modules" });
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/new-shared/format.ts")).toBeDefined();
    expect(edge(store, "file:src/legacy-old.js", "IMPORTS", "file:src/shared/format.ts")).toBeDefined();
  });

  it("package.json changed (imports map)", async () => {
    repo.edit("package.json", '"type": "module"', '"type": "module",\n  "imports": { "#fmt": "./src/shared/format.ts" }');
    const r = await step("package.json changed");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(fresh(r, "src/app.ts")).toMatchObject({ modules: "stale-config" });
    expect(edge(store, "file:src/app.ts", "IMPORTS", "file:src/shared/format.ts")).toBeDefined();
    expect(edge(store, "sym:src/app.ts#main", "CALLS", "sym:src/shared/format.ts#format")).toBeDefined();
  });

  it("Git commit added (history window recomputed)", async () => {
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "APP-10 wrap up");
    const r = await step("Git commit added");
    expect(r.metrics.history.recomputed).toBe(true);
    expect(r.metrics.files.analyzed).toBe(0);
    expect((store.getNode({ type: "issue", id: "APP-10" } as never)?.payload.commits as string[]).length).toBe(3);
  });

  it("the rolling window drops co-change pairs whose commits left it", async () => {
    expect(edgeCount(store, "CHANGED_WITH")).toBeGreaterThan(0);
    for (let i = 1; i <= WINDOW; i++) {
      repo.write("notes.txt", `note ${i}\n`);
      repo.git("add", "notes.txt");
      repo.git("commit", "-q", "-m", `notes ${i}`);
    }
    const r = await step("history window moved");
    expect(r.metrics.history.recomputed).toBe(true);
    expect(edgeCount(store, "CHANGED_WITH")).toBe(0);
  });
});

