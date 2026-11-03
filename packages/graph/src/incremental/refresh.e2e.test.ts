import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { readFingerprintFile } from "@duo-director/analyzer";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "./indexer.js";
import { refreshIndexIfSafe } from "./refresh.js";
import { INDEX_WRITE_LOCK_PATH, withIndexWriteLock } from "./write-lock.js";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, readIndexState } from "./state.js";
import { baseRegistry, makeRepo, type TestRepo } from "./testing.js";
import { dumpGraph } from "../check.js";

const temps: string[] = [];
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await baseRegistry(); });
afterAll(() => { registry.dispose(); temps.forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
const repo = () => makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: refresh\n", "src/a.ts": "export const a = 1;\n" });
async function index(r: TestRepo) {
  const opened = openProjectGraphStore(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try { return await indexRepository(r.root, { store: opened.value, registry }); } finally { opened.value.close(); }
}
function assertConsistent(r: TestRepo) {
  const state = readIndexState(r.root).state;
  const opened = openProjectGraphReader(r.root);
  try { expect(opened.value?.readMeta(INDEX_STATE_TOKEN_KEY)).toBe(state?.token); } finally { opened.value?.close(); }
  expect(readFingerprintFile(r.root).value).toEqual(state?.files.map(({ path, state, fingerprintMode, contentHash, size, gitBlobOid }) => ({ path, state, fingerprintMode, contentHash, size, ...(gitBlobOid === undefined ? {} : { gitBlobOid }) })));
}

describe("safe index recovery and shared writer lock", () => {
  it("never bootstraps a missing index", async () => {
    const r = repo();
    const result = await refreshIndexIfSafe(r.root, { registry });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("missing");
    expect(fs.existsSync(path.join(r.root, INDEX_STATE_FILE_PATH))).toBe(false);
    expect(fs.existsSync(path.join(r.root, ".duo-project/generated/graph.db"))).toBe(false);
  });
  it("refuses incompatible state without rebuilding it", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    r.write(INDEX_STATE_FILE_PATH, "{broken");
    const before = r.read(INDEX_STATE_FILE_PATH);
    expect((await refreshIndexIfSafe(r.root, { registry })).value).toBeUndefined();
    expect(r.read(INDEX_STATE_FILE_PATH)).toBe(before);
  });
  it("serializes competing refresh calls, rechecks freshness and refreshes once", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    const truth = r.read(".duo-project/project.yaml");
    r.git("commit", "--allow-empty", "-qm", "move HEAD");
    const results = await Promise.all(Array.from({ length: 4 }, () => refreshIndexIfSafe(r.root, { registry, lockTimeoutMs: 60_000 })));
    expect(results.map((x) => x.value?.refreshed).sort()).toEqual([false, false, false, true]);
    expect(r.read(".duo-project/project.yaml")).toBe(truth);
    expect(r.read("src/a.ts")).toBe("export const a = 1;\n");
    assertConsistent(r);
  }, 120_000);
  it("uses GRAPH_WRITE_REFUSED with a distinct timeout reason and releases after exceptions", async () => {
    const r = repo();
    const lock = path.join(r.root, INDEX_WRITE_LOCK_PATH);
    fs.mkdirSync(lock, { recursive: true });
    const result = await withIndexWriteLock(r.root, async () => "unreachable", { lockTimeoutMs: 0 });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "GRAPH_WRITE_REFUSED", message: expect.stringContaining("Index lock timeout") });
    fs.rmdirSync(lock);
    await expect(withIndexWriteLock(r.root, async () => { throw new Error("intentional"); })).rejects.toThrow("intentional");
    expect(fs.existsSync(lock)).toBe(false);
    expect((await withIndexWriteLock(r.root, async () => "released")).value).toBe("released");
  });
  it("never treats an inherited async context as lock ownership", async () => {
    const r = repo();
    let entered = false;
    const outer = await withIndexWriteLock(r.root, async () => withIndexWriteLock(r.root, async () => { entered = true; }, { lockTimeoutMs: 0 }));
    expect(entered).toBe(false);
    expect(outer.value?.diagnostics[0]?.message).toContain("Index lock timeout");
  });
  it("observes ignored Truth independently of Git membership", async () => {
    const r = repo();
    r.write(".git/info/exclude", ".duo-project/intent/\n");
    r.write(".duo-project/intent/constraints.yaml", "constraints: []\n");
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "export const a = 2;\n");
    const store = openProjectGraphStore(r.root).value!;
    try {
      const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "analysis") r.write(".duo-project/intent/constraints.yaml", "# changed while ignored\nconstraints: []\n");
      } });
      expect(result.value).toBeUndefined();
      expect(result.diagnostics[0]?.message).toContain("inputs changed");
    } finally { store.close(); }
  });
  it("incrementally refreshes newly added Truth when the current scan observes it", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    r.write(".duo-project/intent/constraints.yaml", "constraints: []\n");
    expect((await refreshIndexIfSafe(r.root, { registry })).value).toEqual({ refreshed: true });
    expect(readIndexState(r.root).state?.files.some((file) => file.path === ".duo-project/intent/constraints.yaml")).toBe(true);
  });
  for (const stale of [false, true]) {
    it(`refuses unobserved ignored Truth before claiming an index ${stale ? "refreshed" : "current"}`, async () => {
      const r = repo();
      r.write(".git/info/exclude", ".duo-project/intent/\n");
      r.write(".duo-project/intent/constraints.yaml", "constraints: []\n");
      expect((await index(r)).value).toBeDefined();
      const state = r.read(INDEX_STATE_FILE_PATH);
      r.write(".duo-project/intent/constraints.yaml", "# changed before recovery\nconstraints: []\n");
      if (stale) r.write("src/a.ts", "export const a = 2;\n");
      const result = await refreshIndexIfSafe(r.root, { registry });
      expect(result.value).toBeUndefined();
      expect(result.diagnostics[0]?.message).toContain("Truth inputs absent from the index");
      expect(r.read(INDEX_STATE_FILE_PATH)).toBe(state);
    });
  }
  for (const wasPresent of [false, true]) {
    it(`rejects an ignored config ${wasPresent ? "changed" : "created"} after resolution before commit`, async () => {
      const r = repo();
      expect((await index(r)).value).toBeDefined();
      r.write(".git/info/exclude", "tsconfig.json\n");
      if (wasPresent) r.write("tsconfig.json", "{}\n");
      r.write("src/a.ts", "export const a = 2;\n");
      const store = openProjectGraphStore(r.root).value!;
      const token = store.readMeta(INDEX_STATE_TOKEN_KEY);
      try {
        const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
          if (phase === "graph-plan") r.write("tsconfig.json", '{"compilerOptions":{"baseUrl":"."}}\n');
        } });
        expect(result.value).toBeUndefined();
        expect(result.diagnostics[0]?.message).toContain("inputs changed");
        expect(store.readMeta(INDEX_STATE_TOKEN_KEY)).toBe(token);
      } finally { store.close(); }
    });
  }
  it("refuses recovery if inspected state disappears rather than falling back to a full rebuild", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "export const a = 2;\n");
    const result = await refreshIndexIfSafe(r.root, { registry, onPhase: (phase) => {
      if (phase === "state") fs.rmSync(path.join(r.root, INDEX_STATE_FILE_PATH), { force: true });
    } });
    expect(result.value).toBeUndefined();
    expect(fs.existsSync(path.join(r.root, INDEX_STATE_FILE_PATH))).toBe(false);
  });
  it("does not report a current index when its state disappears during inspection", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    const result = await refreshIndexIfSafe(r.root, { registry, onPhase: (phase) => {
      if (phase === "state") fs.rmSync(path.join(r.root, INDEX_STATE_FILE_PATH), { force: true });
    } });
    expect(result.value).toBeUndefined();
    expect(fs.existsSync(path.join(r.root, INDEX_STATE_FILE_PATH))).toBe(false);
  });
  for (const kind of ["source", "Truth", "HEAD", "file set", "config"] as const) {
    it(`refuses a ${kind} change during indexing without committing a mixed graph`, async () => {
      const r = repo();
      expect((await index(r)).value).toBeDefined();
      r.write("src/a.ts", "export const a = 2;\n");
      const store = openProjectGraphStore(r.root).value!;
      const before = dumpGraph(store);
      const token = store.readMeta(INDEX_STATE_TOKEN_KEY);
      try {
        const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
          if (phase !== "analysis") return;
          if (kind === "source") r.write("src/a.ts", "export const a = 3;\n");
          if (kind === "Truth") r.write(".duo-project/project.yaml", "schema_version: 1\nname: changed\n");
          if (kind === "HEAD") r.git("commit", "--allow-empty", "-qm", "move during refresh");
          if (kind === "file set") r.write("src/new.ts", "export const b = 1;\n");
          if (kind === "config") r.write("tsconfig.json", "{}\n");
        } });
        expect(result.value).toBeUndefined();
        expect(result.diagnostics[0]?.message).toContain("inputs changed");
        expect(dumpGraph(store)).toEqual(before);
        expect(store.readMeta(INDEX_STATE_TOKEN_KEY)).toBe(token);
      } finally { store.close(); }
    }, 60_000);
  }
  it("does not report successful recovery when inputs change after the commit", async () => {
    const r = repo();
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "export const a = 2;\n");
    const result = await refreshIndexIfSafe(r.root, { registry, onPhase: (phase) => {
      if (phase === "write") r.write("src/a.ts", "export const a = 3;\n");
    } });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("inputs changed");
  }, 60_000);
});
