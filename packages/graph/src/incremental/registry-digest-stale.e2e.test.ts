/**
 * RC.2 upgrade check (release:upgrade 0.4.0-rc.1 -> next): an analyzer changed between versions (here TS/JS, #121 and
 * #131) but no indexed file uses it (a Python or C++ repository). No file needs re-analysis, so inspection said
 * current, yet the next index rewrote the state (new analyzer identities and registry digest, so a new token).
 * "current" must mean the next index writes nothing, as for relationRulesVersion (C233). A changed registry digest
 * is now stale; one index run (nothing parsed, graph unchanged) records it and the index is current again.
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { refreshIndexIfSafe } from "./refresh.js";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, indexStateToken, readIndexState } from "./state.js";
import { baseRegistry, cleanRebuild, makeRepo, memoryStore } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const temps: string[] = [];
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await baseRegistry(); });
afterAll(() => { registry?.dispose(); temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })); });

describe("an analyzer that changed but analyzes no file in this repository (RC.2 upgrade)", () => {
  it("reports stale until one index run records the new registry, which parses nothing and keeps the graph", async () => {
    const repo = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: billing\n",
      "pyproject.toml": "[project]\nname = \"billing\"\n",
      "src/billing/__init__.py": "",
      "src/billing/core.py": "from billing.rates import rate\n\n\ndef total(amount):\n    return amount * 2 + rate()\n",
      "src/billing/rates.py": "def rate():\n    return 1\n",
    });
    const store = memoryStore();
    try {
      expect((await indexRepository(repo.root, { store, registry })).value).toBeDefined();
      // The state an older DUO wrote: same files and analyses, another TypeScript analyzer identity and registry digest.
      const state = readIndexState(repo.root).state as unknown as { analyzers: Record<string, string>; analyzerRegistryDigest: string };
      expect(Object.keys(state.analyzers)).toContain("typescript");
      const older = { ...state, analyzers: { ...state.analyzers, typescript: "sha256:older-typescript-analyzer" }, analyzerRegistryDigest: "sha256:older-registry" };
      const token = indexStateToken(older as never);
      fs.writeFileSync(path.join(repo.root, INDEX_STATE_FILE_PATH), `${JSON.stringify({ ...older, token })}\n`);
      store.transaction((tx) => tx.writeMeta(INDEX_STATE_TOKEN_KEY, token));
      const graphBefore = dumpGraph(store);

      const before = await inspectIndex(repo.root, { graph: store, registry });
      expect(before.value?.status).toBe("stale");
      expect(before.value?.wouldRebuild.parse).toEqual([]);

      const again = await indexRepository(repo.root, { store, registry });
      expect(again.value?.metrics.files.analyzed).toBe(0);
      expect(dumpGraph(store)).toEqual(graphBefore);
      expect((await inspectIndex(repo.root, { graph: store, registry })).value?.status).toBe("current");
      // current means current: the next run writes nothing.
      const third = await indexRepository(repo.root, { store, registry });
      expect(third.value?.metrics.graph.written).toBe(false);
      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, registry, 500));
    } finally { store.close(); }
  });

  it("lets the MCP safe refresh handle it: one incremental refresh (no full rebuild, nothing parsed), then current", async () => {
    const repo = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: game\n",
      "Source/Game/Public/Weapon.h": "class AWeapon {\npublic:\n  void Fire(int Shots);\n};\n",
      "Source/Game/Private/Weapon.cpp": "#include \"Weapon.h\"\n\nvoid AWeapon::Fire(int Shots) {\n  (void)Shots;\n}\n",
    });
    const writer = openProjectGraphStore(repo.root).value;
    if (writer === undefined) throw new Error("graph");
    try {
      expect((await indexRepository(repo.root, { store: writer, registry })).value).toBeDefined();
      const state = readIndexState(repo.root).state as unknown as { analyzers: Record<string, string>; analyzerRegistryDigest: string };
      const older = { ...state, analyzers: { ...state.analyzers, javascript: "sha256:older-javascript-analyzer" }, analyzerRegistryDigest: "sha256:older-registry" };
      const token = indexStateToken(older as never);
      fs.writeFileSync(path.join(repo.root, INDEX_STATE_FILE_PATH), `${JSON.stringify({ ...older, token })}\n`);
      writer.transaction((tx) => tx.writeMeta(INDEX_STATE_TOKEN_KEY, token));
    } finally { writer.close(); }
    const read = async () => {
      const reader = openProjectGraphReader(repo.root).value;
      if (reader === undefined) throw new Error("graph");
      try { return { status: (await inspectIndex(repo.root, { graph: reader, registry })).value?.status, graph: dumpGraph(reader as never) }; } finally { reader.close(); }
    };
    const before = await read();
    expect(before.status).toBe("stale");
    const refreshed = await refreshIndexIfSafe(repo.root, { registry });
    expect(refreshed.diagnostics).toEqual([]);
    expect(refreshed.value).toEqual({ refreshed: true });
    const after = await read();
    expect(after.status).toBe("current");
    expect(after.graph).toEqual(before.graph);
    // A second refresh finds it current and does nothing.
    expect((await refreshIndexIfSafe(repo.root, { registry })).value).toEqual({ refreshed: false });
  });
});
