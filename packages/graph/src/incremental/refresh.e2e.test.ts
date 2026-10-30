import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { readFingerprintFile } from "@duo-director/analyzer";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
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
async function inspect(r: TestRepo) {
  const opened = openProjectGraphReader(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try { return (await inspectIndex(r.root, { graph: opened.value, registry })).value?.status; } finally { opened.value.close(); }
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
    let releaseHolder = (): void => {};
    const holding = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderStarted = (): void => {};
    const started = new Promise<void>((resolve) => { holderStarted = resolve; });
    const holder = withIndexWriteLock(r.root, async () => { holderStarted(); await holding; });
    await started;
    const result = await withIndexWriteLock(r.root, async () => "unreachable", { lockTimeoutMs: 0 });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "GRAPH_WRITE_REFUSED", message: expect.stringContaining("Index lock timeout") });
    releaseHolder();
    await holder;
    await expect(withIndexWriteLock(r.root, async () => { throw new Error("intentional"); })).rejects.toThrow("intentional");
    expect((await withIndexWriteLock(r.root, async () => "released", { lockTimeoutMs: 0 })).value).toBe("released");
    expect(fs.statSync(path.join(r.root, INDEX_WRITE_LOCK_PATH)).isFile()).toBe(true);
  });
  it("guards only the configured index scope: an edit outside index.include does not fail an explicit index", async () => {
    const r = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: scoped\nindex:\n  include:\n    - \"src/**\"\n",
      "src/a.ts": "export const a = 1;\n",
      "other/b.ts": "export const b = 1;\n",
    });
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "export const a = 2;\n");
    const store = openProjectGraphStore(r.root).value!;
    try {
      const outside = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "analysis") r.write("other/b.ts", "export const b = 2;\n");
      } });
      expect(outside.value?.mode).toBe("incremental");
      r.write("src/a.ts", "export const a = 3;\n");
      const inside = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "analysis") r.write("src/a.ts", "export const a = 4;\n");
      } });
      expect(inside.value).toBeUndefined();
      expect(inside.diagnostics[0]?.message).toContain("inputs changed");
    } finally { store.close(); }
  });
  it("never treats an inherited async context as lock ownership", async () => {
    const r = repo();
    let entered = false;
    const outer = await withIndexWriteLock(r.root, async () => withIndexWriteLock(r.root, async () => { entered = true; }, { lockTimeoutMs: 0 }));
    expect(entered).toBe(false);
    expect(outer.value?.diagnostics[0]?.message).toContain("Index lock timeout");
  });
  it("observes a change to ignored Truth content independently of Git membership", async () => {
    const r = repo();
    r.write(".git/info/exclude", ".duo-project/intent/\n");
    r.write(".duo-project/intent/vision.md", "---\nstatus: draft\n---\n\n# Vision\n\nOne.\n");
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "export const a = 2;\n");
    const store = openProjectGraphStore(r.root).value!;
    try {
      const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "analysis") r.write(".duo-project/intent/vision.md", "---\nstatus: draft\n---\n\n# Vision\n\nTwo.\n");
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
  for (const stale of [false, true]) {
    it(`does not report ${stale ? "a refresh" : "a current index"} when a source changes after the inspection read it (T181)`, async () => {
      const r = repo();
      expect((await index(r)).value).toBeDefined();
      if (stale) r.write("src/a.ts", "export const a = 2;\n");
      let inspections = 0;
      const result = await refreshIndexIfSafe(r.root, { registry, onPhase: (phase) => {
        // The last inspection's analysis phase: after it has fingerprinted every file.
        if (phase === "analysis" && ++inspections === (stale ? 3 : 1)) r.write("src/a.ts", "export const a = 9;\n");
      } });
      expect(result.value).toBeUndefined();
      expect(result.diagnostics[0]?.message).toContain("inputs changed");
    });
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
  it("does not report successful recovery when an ignored config that did not exist appears after the commit (#149 review)", async () => {
    const r = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: refresh\n",
      ".gitignore": "tsconfig.json\n",
      "src/a.ts": "import { b } from \"@lib/b\";\n\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    expect((await index(r)).value).toBeDefined();
    r.write("src/a.ts", "import { b } from \"@lib/b\";\n\nexport const a = b + 1;\n");
    const result = await refreshIndexIfSafe(r.root, { registry, onPhase: (phase) => {
      if (phase === "write") r.write("tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/*"]}}}\n');
    } });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain("inputs changed");
  }, 60_000);
  // F3 (T182 maintainer decision): an explicit index keeps its pre-#143 scope. A run that writes nothing
  // does not read its inputs a second time, and a change after the pre-commit check is not re-checked.
  // Such a run may report success, but the database token, index-state.json and the fingerprint file
  // must still agree, and the next run must see the change as stale and index it.
  for (const when of ["no-op run", "after the commit"] as const) {
    it(`keeps DB token, index state and fingerprints consistent when a source changes ${when} of an explicit index (F3)`, async () => {
      const r = repo();
      expect((await index(r)).value).toBeDefined();
      if (when === "after the commit") r.write("src/a.ts", "export const a = 2;\n");
      const store = openProjectGraphStore(r.root).value!;
      const token = store.readMeta(INDEX_STATE_TOKEN_KEY);
      let result;
      try {
        result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
          if (phase === (when === "no-op run" ? "analysis" : "write")) r.write("src/a.ts", "export const a = 9;\n");
        } });
      } finally { store.close(); }
      expect(result.value).toBeDefined();
      expect(result.value?.metrics.graph.written).toBe(when === "after the commit");
      assertConsistent(r);
      const state = readIndexState(r.root).state;
      if (when === "no-op run") expect(state?.token).toBe(token);
      else expect(state?.token).not.toBe(token);
      expect(await inspect(r)).toBe("stale");
      const next = await index(r);
      expect(next.value?.metrics.files.changed).toBe(1);
      assertConsistent(r);
      expect(await inspect(r)).toBe("current");
      expect(r.read("src/a.ts")).toBe("export const a = 9;\n");
    }, 60_000);
  }
});
