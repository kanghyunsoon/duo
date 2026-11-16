/**
 * #151 Stage A: an ignored tsconfig.json/jsconfig.json (or one index.exclude leaves out of the scan) created after an
 * index. Before this change, an incremental index reused the stored module results of every unchanged importer, so
 * importers that were not edited kept the resolution from before the config, while an edited importer used the
 * config. index-state then recorded the config as known, and nothing made the index stale again until --full.
 *
 * Now the builder reuses a stored TypeScript/JavaScript resolution only if the config chain that applies to the
 * file now is the one it was resolved with. Every case is checked against a clean full rebuild of the same tree.
 * The index-state format (v4) is unchanged. Detecting such a config without running index (status, MCP) is Stage B.
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { readIndexState } from "./state.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";
import type { IndexResult } from "./types.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WINDOW = 6;
const temps: string[] = [];
const stores: GraphStore[] = [];
let base: AnalyzerRegistry;

beforeAll(async () => {
  base = await baseRegistry();
});
afterAll(() => {
  stores.forEach((s) => s.close());
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const CASES = [
  { config: "tsconfig.json", ext: "ts" },
  { config: "jsconfig.json", ext: "js" },
] as const;

function setup(config: string, ext: string): { repo: TestRepo; store: GraphStore } {
  const repo = makeRepo(temps, {
    ".duo-project/project.yaml": "schema_version: 1\nname: issue151\n",
    ".gitignore": `.duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n${config}\n`,
    [`src/a.${ext}`]: "import { x } from '@lib/x';\nexport const a = x;\n",
    [`src/b.${ext}`]: "import { x } from '@lib/x';\nexport const b = x;\n",
    [`src/lib/x.${ext}`]: "export const x = 1;\n",
  });
  const store = memoryStore();
  stores.push(store);
  return { repo, store };
}

const CONFIG_TEXT = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } });

async function index(repo: TestRepo, store: GraphStore): Promise<IndexResult> {
  const r = await indexRepository(repo.root, { store, registry: base, historyWindow: WINDOW });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  // The incremental result is the clean full rebuild of the same tree.
  expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, WINDOW));
  return r.value;
}

const imports = (store: GraphStore, ext: string) => ({
  a: edge(store, `file:src/a.${ext}`, "IMPORTS", `file:src/lib/x.${ext}`) !== undefined,
  b: edge(store, `file:src/b.${ext}`, "IMPORTS", `file:src/lib/x.${ext}`) !== undefined,
});

describe.each(CASES)("#151 Stage A: an ignored $config created after an index", ({ config, ext }) => {
  it("an edited importer and the unchanged importers resolve with the new config", async () => {
    const { repo, store } = setup(config, ext);
    await index(repo, store);
    expect(imports(store, ext)).toEqual({ a: false, b: false });

    repo.write(config, CONFIG_TEXT);
    fs.appendFileSync(`${repo.root}/src/a.${ext}`, "// edited\n");
    const r = await index(repo, store);
    expect(r.mode).toBe("incremental");
    expect(imports(store, ext)).toEqual({ a: true, b: true });
    expect(Object.keys(readIndexState(repo.root).state?.configs ?? {})).toEqual([config]);
    // Both import references were resolved again (src/lib/x has none, but its recorded config chain is updated too).
    expect(r.metrics.resolution.modulesRecomputed).toBe(2);
    expect(r.metrics.resolution.modulesReused).toBe(0);
  });

  it("an explicit index with no source edit resolves every importer with the new config", async () => {
    const { repo, store } = setup(config, ext);
    await index(repo, store);
    repo.write(config, CONFIG_TEXT);
    const r = await index(repo, store);
    expect(r.mode).toBe("incremental");
    expect(r.metrics.files.analyzed).toBe(0);
    expect(imports(store, ext)).toEqual({ a: true, b: true });
  });

  it("a rerun with the config in place reuses every resolution and writes nothing", async () => {
    const { repo, store } = setup(config, ext);
    repo.write(config, CONFIG_TEXT);
    await index(repo, store);
    const revision = store.readMeta("graph_revision");
    const r = await index(repo, store);
    expect(r.metrics.resolution.modulesRecomputed).toBe(0);
    expect(r.metrics.graph.written).toBe(false);
    expect(store.readMeta("graph_revision")).toBe(revision);
  });

  it("deleting the recorded config resolves the importers without it again (unchanged behavior)", async () => {
    const { repo, store } = setup(config, ext);
    repo.write(config, CONFIG_TEXT);
    await index(repo, store);
    expect(imports(store, ext)).toEqual({ a: true, b: true });
    repo.remove(config);
    await index(repo, store);
    expect(imports(store, ext)).toEqual({ a: false, b: false });
    expect(readIndexState(repo.root).state?.configs).toEqual({});
  });
});
