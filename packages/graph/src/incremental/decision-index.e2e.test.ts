import fs from "node:fs";
import { createDecisionService, definitionRef } from "@duo-director/core";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { baseRegistry, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
let repo: TestRepo;
let store: GraphStore;
beforeAll(async () => {
  base = await baseRegistry();
  repo = makeRepo(temps);
  store = memoryStore();
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
});
afterAll(() => {
  store?.close();
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("TASK-009 × TASK-008: Decision files are the Source of Truth; the Graph follows at the next index", () => {
  it("confirm writes files only; inspect sees it; the next index adds the Decision and its SUPERSEDES edge", async () => {
    const decisions = createDecisionService({ root: repo.root, clock: () => new Date("2026-09-27T00:00:00.000Z") });
    const graphBefore = dumpGraph(store);
    const proposed = await decisions.propose({ kind: "agent", name: "codex" }, {
      title: "Passkey only", question: "login_mechanism", answer: "passkey-only", governs: { requirements: ["APP-01"] }, enforcement: "block", supersedes: "D-002",
    });
    expect(proposed.value?.proposalId).toBe("P-001");
    expect((await indexRepository(repo.root, { store, registry: base })).value?.metrics.files.analyzed).toBe(0);
    expect(store.getNode(definitionRef("decision", "P-001"))).toBeUndefined(); // a proposal is not a Graph node
    const confirmed = await decisions.confirm({ kind: "human", name: "kanghyunsoon" }, "P-001");
    expect(confirmed.value).toMatchObject({ decisionId: "D-003", indexRequired: true });
    expect(dumpGraph(store).nodes.filter((n) => n.includes("dec:D-003"))).toEqual([]);
    expect(graphBefore.nodes.length).toBeGreaterThan(0);

    const status = await inspectIndex(repo.root, { graph: store, registry: base });
    expect(status.value).toMatchObject({ status: "stale", projectTruth: { changed: [".duo-project/decisions/D-002.yaml", ".duo-project/decisions/D-003.yaml", ".duo-project/decisions/proposals/P-001.yaml"] }, wouldRebuild: { parse: [] } });

    const run = await indexRepository(repo.root, { store, registry: base });
    expect(run.value?.metrics.files.analyzed).toBe(0);
    expect(store.getNode(definitionRef("decision", "D-003"))?.payload).toEqual({ decisionKind: "decision", title: "Passkey only", state: "confirmed", enforcement: "block" });
    expect(edge(store, "dec:D-003", "GOVERNS", "req:APP-01")).toBeDefined();
    expect(edge(store, "dec:D-003", "SUPERSEDES", "dec:D-002")).toBeDefined();
    expect(store.getNode(definitionRef("decision", "D-002"))?.payload.state).toBe("superseded");
  });
});

