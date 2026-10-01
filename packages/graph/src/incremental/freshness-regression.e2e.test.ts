/**
 * T25.1 freshness regression (also the T22 cache-prefetch scenarios): inspectIndex reports what it reported
 * before the cache check became concurrent and the work-tree prefix query was shared, the Indexer agrees, and
 * incremental index == clean full rebuild after every scenario. Also: relation rules version (T24.5), Python
 * metadata and package layout (T24.2), analyzer identity, and a root that is not the work-tree top level.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { ANALYSIS_CACHE_DIR, analysisCacheFileName } from "./analysis-cache.js";
import { indexRepository } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, indexStateToken, readIndexState } from "./state.js";
import { baseRegistry, cleanRebuild, countingRegistry, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const FILES: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: fresh\n",
  "src/a.ts": "export function a(): number {\n  return 1;\n}\n",
  "src/b.ts": "import { a } from \"./a\";\nexport const b = (): number => a();\n",
  "src/Main.java": "class Main {\n  int one() { return 1; }\n}\n",
  "py/pyproject.toml": "[project]\nname = \"pkg\"\n",
  "py/src/pkg/__init__.py": "",
  "py/src/pkg/mod.py": "def f():\n    return 1\n",
  "py/src/pkg/use.py": "from pkg.mod import f\n\n\ndef g():\n    return f()\n",
};

async function setup(): Promise<{ repo: TestRepo; store: GraphStore }> {
  const repo = makeRepo(temps, FILES);
  const store = memoryStore();
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return { repo, store };
}
const inspect = async (repo: TestRepo, store: GraphStore, registry = base) => {
  const r = await inspectIndex(repo.root, { graph: store, registry });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};
/** The cache entry file of an indexed path. */
function entryOf(repo: TestRepo, file: string): string {
  const f = readIndexState(repo.root).state?.files.find((x) => x.path === file);
  if (f?.analysis === undefined) throw new Error("not analyzed: " + file);
  return path.join(repo.root, ANALYSIS_CACHE_DIR, analysisCacheFileName({ path: f.path, contentHash: f.contentHash, analyzer: f.analysis.analyzer, analyzerIdentity: f.analysis.identity }));
}
/** Rewrites the index state as an older DUO would have written it (token kept consistent in the state and the graph). */
function rewriteState(repo: TestRepo, store: GraphStore, change: (s: Record<string, unknown>) => void): void {
  const state = readIndexState(repo.root).state as unknown as Record<string, unknown>;
  change(state);
  const token = indexStateToken(state as never);
  fs.writeFileSync(path.join(repo.root, INDEX_STATE_FILE_PATH), `${JSON.stringify({ ...state, token })}\n`);
  store.transaction((tx) => tx.writeMeta(INDEX_STATE_TOKEN_KEY, token));
}
const recordOf = (i: Awaited<ReturnType<typeof inspect>>, p: string) => i.freshness.find((r) => r.path === p);

/** [scenario, change, status, files that would be parsed, the record checked] */
const SCENARIOS: [string, (repo: TestRepo) => void, "current" | "stale", string[], [string, Record<string, unknown>] | undefined][] = [
  ["no change", () => {}, "current", [], undefined],
  ["TypeScript source edit", (r) => r.edit("src/a.ts", "return 1;", "return 2;"), "stale", ["src/a.ts"], ["src/a.ts", { file: "changed", analysis: "stale-content" }]],
  ["source delete", (r) => r.remove("src/b.ts"), "stale", [], ["src/b.ts", { file: "deleted" }]],
  ["source rename", (r) => r.rename("src/b.ts", "src/c.ts"), "stale", ["src/c.ts"], ["src/c.ts", { file: "added", analysis: "missing" }]],
  ["same bytes rewritten, timestamp only", (r) => { const p = path.join(r.root, "src/a.ts"); fs.writeFileSync(p, fs.readFileSync(p)); const t = new Date(Date.now() + 60_000); fs.utimesSync(p, t, t); }, "current", [], ["src/a.ts", { file: "fresh", analysis: "fresh" }]],
  ["cache entry truncated", (r) => fs.writeFileSync(entryOf(r, "src/a.ts"), "{"), "stale", ["src/a.ts"], ["src/a.ts", { file: "fresh", analysis: "missing" }]],
  ["cache entry deleted", (r) => fs.rmSync(entryOf(r, "src/Main.java")), "stale", ["src/Main.java"], ["src/Main.java", { file: "fresh", analysis: "missing" }]],
  ["cache entry replaced by another file's entry", (r) => fs.copyFileSync(entryOf(r, "src/b.ts"), entryOf(r, "src/a.ts")), "stale", ["src/a.ts"], ["src/a.ts", { file: "fresh", analysis: "missing" }]],
  ["new Java source", (r) => r.write("src/Added.java", "class Added {\n  int two() { return 2; }\n}\n"), "stale", ["src/Added.java"], ["src/Added.java", { file: "added", analysis: "missing" }]],
];

describe("freshness regression (T25.1)", () => {
  for (const [label, change, status, parse, record] of SCENARIOS) {
    it(label, async () => {
      const { repo, store } = await setup();
      try {
        change(repo);
        const before = await inspect(repo, store);
        expect(before.status).toBe(status);
        expect(before.wouldRebuild.parse).toEqual(parse);
        if (record !== undefined) expect(recordOf(before, record[0])).toMatchObject(record[1]);
        // Asking twice gives the same answer (inspect writes nothing).
        expect(await inspect(repo, store)).toEqual(before);
        const r = await indexRepository(repo.root, { store, registry: base });
        expect(r.value?.mode).toBe("incremental");
        expect(r.value?.metrics.files.analyzed).toBe(parse.length);
        expect((await inspect(repo, store)).status).toBe("current");
        expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
      } finally {
        store.close();
      }
    });
  }

  it("relation rules version: missing or older is stale, matching is current", async () => {
    const { repo, store } = await setup();
    try {
      expect((await inspect(repo, store)).status).toBe("current");
      for (const change of [(s: Record<string, unknown>) => { delete s.relationRulesVersion; }, (s: Record<string, unknown>) => { s.relationRulesVersion = 0; }]) {
        rewriteState(repo, store, change);
        const i = await inspect(repo, store);
        expect(i.status).toBe("stale");
        expect(i.wouldRebuild).toMatchObject({ full: false, parse: [], projectTruth: true });
        await indexRepository(repo.root, { store, registry: base });
        expect((await inspect(repo, store)).status).toBe("current");
      }
    } finally {
      store.close();
    }
  });

  it("Python metadata and package layout make the same bytes stale; incremental == clean full", async () => {
    const steps: [string, (r: TestRepo) => void][] = [
      ["pyproject.toml change", (r) => r.write("py/pyproject.toml", "[project]\nname = \"pkg\"\n[tool.setuptools]\npackage-dir = {\"\" = \"lib\"}\n")],
      ["setup.cfg added", (r) => r.write("py/setup.cfg", "[options]\npackage_dir =\n    = src\n")],
      ["package structure: __init__.py removed", (r) => r.remove("py/src/pkg/__init__.py")],
    ];
    for (const [label, change] of steps) {
      const { repo, store } = await setup();
      try {
        change(repo);
        const i = await inspect(repo, store);
        expect(i.status, label).toBe("stale");
        expect(i.wouldRebuild.modules.length, label).toBeGreaterThan(0);
        await indexRepository(repo.root, { store, registry: base });
        expect((await inspect(repo, store)).status, label).toBe("current");
        expect(dumpGraph(store), label).toEqual(await cleanRebuild(repo.root, base, 500));
      } finally {
        store.close();
      }
    }
  });

  it("another analyzer identity makes every analyzed file stale", async () => {
    const { repo, store } = await setup();
    const other = countingRegistry(base, "t251");
    try {
      const i = await inspect(repo, store, other.registry);
      expect(i.status).toBe("stale");
      expect(i.wouldRebuild.parse).toEqual(["py/src/pkg/__init__.py", "py/src/pkg/mod.py", "py/src/pkg/use.py", "src/Main.java", "src/a.ts", "src/b.ts"]);
      expect(recordOf(i, "src/a.ts")).toMatchObject({ analysis: "stale-analyzer" });
    } finally {
      store.close();
      other.registry.dispose();
    }
  });

  it("a subdirectory or a directory outside Git is refused as before", async () => {
    const { repo, store } = await setup();
    try {
      const sub = path.join(repo.root, "src");
      // A DUO project in a subdirectory: Truth loads, then the work-tree prefix check refuses the root.
      repo.write("src/.duo-project/project.yaml", "schema_version: 1\nname: sub\n");
      const i = await inspectIndex(sub, { graph: store, registry: base });
      expect(i.value).toBeUndefined();
      expect(i.diagnostics.map((d) => d.code)).toContain("SCAN_ROOT_INVALID");
      expect(i.diagnostics.find((d) => d.code === "SCAN_ROOT_INVALID")?.message).toContain('it is "src/"');
      const x = await indexRepository(sub, { store, registry: base });
      expect(x.value).toBeUndefined();
      expect(x.diagnostics.map((d) => d.code)).toContain("SCAN_ROOT_INVALID");
    } finally {
      store.close();
    }
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-nogit-")));
    temps.push(plain);
    fs.mkdirSync(path.join(plain, ".duo-project"));
    fs.writeFileSync(path.join(plain, ".duo-project/project.yaml"), "schema_version: 1\nname: x\n");
    const s2 = memoryStore();
    try {
      const i = await inspectIndex(plain, { graph: s2, registry: base });
      expect(i.diagnostics.map((d) => d.code)).toContain("GIT_REPOSITORY_REQUIRED");
    } finally {
      s2.close();
    }
  });

  it("Git states keep their answers: unborn, detached HEAD, shallow clone, dirty work tree", async () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "DUO Test", GIT_AUTHOR_EMAIL: "test@duo.invalid", GIT_COMMITTER_NAME: "DUO Test", GIT_COMMITTER_EMAIL: "test@duo.invalid" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
    const fresh = () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-gitstate-")));
      temps.push(dir);
      fs.mkdirSync(path.join(dir, ".duo-project"));
      fs.writeFileSync(path.join(dir, ".duo-project/project.yaml"), "schema_version: 1\nname: g\n");
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
      git(dir, "-c", "init.defaultBranch=main", "init", "-q");
      git(dir, "config", "core.autocrlf", "false");
      git(dir, "add", "-A");
      return dir;
    };
    const twoCommits = () => {
      const dir = fresh();
      git(dir, "commit", "-qm", "one");
      fs.appendFileSync(path.join(dir, "src/a.ts"), "export const b = 2;\n");
      git(dir, "commit", "-qam", "two");
      return dir;
    };
    /** Full index, then inspect is current; then a dirty edit is stale for that file only and one index catches up. */
    const check = async (root: string) => {
      const store = memoryStore();
      try {
        const first = await indexRepository(root, { store, registry: base });
        expect(first.value?.mode).toBe("full");
        const i = await inspectIndex(root, { graph: store, registry: base });
        expect(i.value?.status).toBe("current");
        expect(i.value?.history.wouldRecompute).toBe(false);
        fs.appendFileSync(path.join(root, "src/a.ts"), "export const dirty = 3;\n");
        const dirty = await inspectIndex(root, { graph: store, registry: base });
        expect(dirty.value?.status).toBe("stale");
        expect(dirty.value?.wouldRebuild.parse).toEqual(["src/a.ts"]);
        expect((await indexRepository(root, { store, registry: base })).value?.mode).toBe("incremental");
        expect((await inspectIndex(root, { graph: store, registry: base })).value?.status).toBe("current");
        expect(dumpGraph(store)).toEqual(await cleanRebuild(root, base, 500));
      } finally {
        store.close();
      }
    };
    await check(fresh()); // unborn: staged files, no commit
    const detached = twoCommits();
    git(detached, "checkout", "-q", "--detach", "HEAD~1");
    await check(detached);
    const source = twoCommits();
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-shallow-")));
    temps.push(parent);
    git(parent, "clone", "-q", "--depth", "1", pathToFileURL(source).href, "clone");
    const shallow = path.join(parent, "clone");
    expect(git(shallow, "rev-parse", "--is-shallow-repository").trim()).toBe("true");
    await check(shallow);
  });
});

