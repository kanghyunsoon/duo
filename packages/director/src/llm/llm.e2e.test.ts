import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, GAP_FIXTURE, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { assessKnowledgeGaps } from "../gap/assess.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry, GAP_FIXTURE);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("Deterministic First, LLM Optional (TASK-012A)", () => {
  it("with no provider and the network blocked, Context and Knowledge Gap work and call no LLM", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off"));
    try {
      for (const task of ["NETWORK-01 멀티플레이 서버 확장 구조 설계", "DB migration index 추가", "fix normalize"]) {
        const result = await repo.compile({ task });
        const a = assessKnowledgeGaps({ request: { task }, result, truth: repo.truth() });
        expect(result.status === "ready" ? result.packet?.metrics.llmCalls : 0).toBe(0);
        expect(result.metrics?.llmCalls ?? 0).toBe(0);
        expect(a.metrics.llmCalls).toBe(0);
        expect(a.status).toBe("assessed");
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
