/**
 * H-78 (T45): Issue.implements.paths becomes File IMPLEMENTS Issue edges (declared, implements.paths). Adding,
 * changing and removing the scope keeps incremental index == clean full rebuild (H-25).
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => { base?.dispose(); temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })); });

const spec = (block: string) => ["# Tasks", "", "## TASK-015 Desktop shell", "", "```duo", "type: issue", "status: todo", ...block.split("\n").filter((l) => l !== ""), "```", "", "Build the desktop shell.", ""].join("\n");
const SPEC = ".duo-project/specs/tasks.md";
async function index(repo: TestRepo, store: GraphStore) {
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
const implementers = (store: GraphStore) => store.adjacentEdges([{ type: "issue", id: "TASK-015" } as never], { direction: "incoming", types: ["IMPLEMENTS"], limit: 100 }).edges.map((e) => e.from).sort();

describe("Issue IMPLEMENTS edges (H-78)", () => {
  it("declared edges from matching Files; add, change and remove keep incremental == full rebuild", async () => {
    const repo = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: t45\n",
      [SPEC]: spec(""),
      "apps/desktop/src/main.ts": "export const main = (): number => 1;\n",
      "apps/desktop/src/preload.ts": "export const preload = (): number => 2;\n",
      "apps/payment/charge.ts": "export const charge = (n: number): number => n;\n",
    });
    const store = memoryStore();
    try {
      await index(repo, store);
      expect(implementers(store)).toEqual([]);
      const steps: [string, string, string[]][] = [
        ["add a scope", "implements:\n  paths: [\"apps/desktop/**\"]", ["file:apps/desktop/src/main.ts", "file:apps/desktop/src/preload.ts"]],
        ["change it", "implements:\n  paths: [\"apps/payment/**\", \"apps/desktop/src/main.ts\"]", ["file:apps/desktop/src/main.ts", "file:apps/payment/charge.ts"]],
        ["remove it", "", []],
      ];
      for (const [label, block, expected] of steps) {
        repo.write(SPEC, spec(block));
        const r = await index(repo, store);
        expect(r.mode, label).toBe("incremental");
        expect(implementers(store), label).toEqual(expected);
        expect(dumpGraph(store), label).toEqual(await cleanRebuild(repo.root, base, 500));
      }
      repo.write(SPEC, spec("implements:\n  paths: [\"apps/desktop/**\"]"));
      await index(repo, store);
      const e = edge(store, "file:apps/desktop/src/main.ts", "IMPLEMENTS", "issue:TASK-015");
      expect(e?.metadata).toMatchObject({ provenance: "declared", basis: ["implements.paths"] });
      // A file added under the scope gets its edge in the next incremental run.
      repo.write("apps/desktop/src/window.ts", "export const win = 3;\n");
      expect((await index(repo, store)).mode).toBe("incremental");
      expect(implementers(store)).toContain("file:apps/desktop/src/window.ts");
      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
    } finally {
      store.close();
    }
  });
});
