import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, countingRegistry, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const FILES = 500;
const name = (i: number) => `f${String(i).padStart(3, "0")}`;
const temps: string[] = [];
let base: AnalyzerRegistry;
let repo: TestRepo;
let store: GraphStore;

beforeAll(async () => {
  base = await baseRegistry();
  const files: Record<string, string> = {
    ".duo-project/project.yaml": "schema_version: 1\nname: big\n",
    "package.json": JSON.stringify({ name: "big", private: true, type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
  };
  for (let i = 0; i < FILES; i++) {
    files[`src/${name(i)}.ts`] = i === 0
      ? `export function ${name(i)}(): number {\n  return 0;\n}\n`
      : `import { ${name(i - 1)} } from "./${name(i - 1)}.js";\n\nexport function ${name(i)}(): number {\n  return ${name(i - 1)}() + 1;\n}\n`;
  }
  repo = makeRepo(temps, files);
  store = memoryStore();
});
afterAll(() => {
  store?.close();
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe(`AC-008-02 parse avoidance on ${FILES} files`, () => {
  it("one changed file is parsed once; only its own and its importer's calls are resolved again", async () => {
    const counting = countingRegistry(base);
    const full = await indexRepository(repo.root, { store, registry: counting.registry });
    expect(full.value?.mode).toBe("full");
    expect(counting.parses).toBe(FILES);

    repo.edit("src/f250.ts", "return f249() + 1;", "return f249() + 2;");
    counting.parses = 0;
    const r = await indexRepository(repo.root, { store, registry: counting.registry });
    const m = r.value?.metrics;
    expect(r.value?.mode).toBe("incremental");
    expect(counting.parses).toBe(1);
    expect(m?.files).toMatchObject({ changed: 1, analyzed: 1, analysisReused: FILES - 1 });
    expect(m?.resolution).toMatchObject({ filesModulesRecomputed: 1, modulesRecomputed: 1, filesCallsRecomputed: 2, callsRecomputed: 2 });
    expect(m?.graph).toMatchObject({ scopesChanged: 1, nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0 });
    expect(r.value?.freshness.find((f) => f.path === "src/f251.ts")).toMatchObject({ analysis: "fresh", modules: "fresh", calls: "stale-dependency" });
    expect(r.value?.freshness.find((f) => f.path === "src/f100.ts")).toMatchObject({ analysis: "fresh", modules: "fresh", calls: "fresh" });

    counting.parses = 0;
    const again = await indexRepository(repo.root, { store, registry: counting.registry });
    expect(counting.parses).toBe(0);
    expect(again.value?.metrics.graph.written).toBe(false);

    expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
  });
});

