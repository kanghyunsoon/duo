/**
 * TASK-010 demo measurement: Repository → candidates → Packet on the context fixture, then the
 * same task after 40 unrelated modules are added. Real o200k_base counts; set
 * DUO_CONTEXT_DEMO_OUT to a file path to record them.
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

/** An unrelated catalog module: pricing helpers that share no names with the auth or lobby code. */
function catalogModule(n: number): string {
  const id = String(n).padStart(2, "0");
  return [
    `/** Catalog pricing rules, family ${id}. */`,
    `export interface Product${id} {`,
    "  sku: string;",
    "  basePrice: number;",
    "  weightGrams: number;",
    "  tags: string[];",
    "}",
    "",
    `/** Price after the family ${id} discount ladder. */`,
    `export function discountedPrice${id}(p: Product${id}, quantity: number): number {`,
    "  const ladder = [[100, 0.2], [50, 0.12], [10, 0.05]] as const;",
    "  const rate = ladder.find(([min]) => quantity >= min)?.[1] ?? 0;",
    "  return Math.round(p.basePrice * quantity * (1 - rate) * 100) / 100;",
    "}",
    "",
    `/** Shipping cost by weight band for family ${id}. */`,
    `export function shippingCost${id}(p: Product${id}, quantity: number): number {`,
    "  const grams = p.weightGrams * quantity;",
    "  if (grams <= 500) return 4.5;",
    "  if (grams <= 2000) return 7.9;",
    "  return 7.9 + Math.ceil((grams - 2000) / 1000) * 2.1;",
    "}",
    "",
    `/** Products of family ${id} that carry every requested tag, cheapest first. */`,
    `export function filterByTags${id}(products: readonly Product${id}[], tags: readonly string[]): Product${id}[] {`,
    "  return products.filter((p) => tags.every((t) => p.tags.includes(t))).sort((a, b) => a.basePrice - b.basePrice || a.sku.localeCompare(b.sku));",
    "}",
    "",
  ].join("\n");
}

const summary = (r: ContextResult) => ({
  status: r.status,
  repository: r.metrics?.repository,
  filesConsidered: r.metrics?.filesConsidered,
  rawCandidateTokens: r.metrics?.rawCandidateTokens,
  candidateTokens: r.metrics?.candidateTokens,
  selectedTokens: r.metrics?.selectedTokens,
  budget: r.metrics?.budget,
  filesLoaded: r.metrics?.filesLoaded,
  reduction: r.metrics?.reduction,
  candidates: r.packet?.metrics.candidates,
  selected: r.packet?.metrics.selected,
  omitted: r.packet?.metrics.omitted,
  cache: r.cache,
  performance: r.performance,
});

describe("TASK-010 demo: repository total → candidates → Packet", () => {
  it("measures the funnel, and unrelated growth leaves the Packet untouched", async () => {
    const tasks = ["GAME-42", "AUTH-03", "LOBBY-01"];
    const base: Record<string, ReturnType<typeof summary>> = {};
    const digests: Record<string, string> = {};
    for (const task of tasks) {
      const r = await repo.compile({ task }, { cache: true });
      expect(r.status).toBe("ready");
      base[task] = summary(r);
      digests[task] = r.packet?.dependencyDigest ?? "";
      const m = r.metrics;
      if (m === undefined) throw new Error("no metrics");
      expect(m.selectedTokens).toBeLessThanOrEqual(m.budget);
      expect(m.selectedTokens).toBeLessThan(m.repository.tokens);
    }

    for (let n = 1; n <= 40; n++) repo.write(`src/catalog/family-${String(n).padStart(2, "0")}.ts`, catalogModule(n));
    await repo.index();
    const grown: Record<string, ReturnType<typeof summary>> = {};
    for (const task of tasks) {
      const r = await repo.compile({ task }, { cache: true });
      grown[task] = summary(r);
      expect(r.cache.status).toBe("hit");
      expect(r.packet?.dependencyDigest).toBe(digests[task]);
      expect(r.metrics?.selectedTokens).toBe(base[task]?.selectedTokens);
      expect(r.metrics?.repository.tokens ?? 0).toBeGreaterThan((base[task]?.repository?.tokens ?? 0) * 3);
    }
    const out = process.env.DUO_CONTEXT_DEMO_OUT;
    if (out !== undefined && out !== "") fs.writeFileSync(out, JSON.stringify({ base, grown }, null, 2));
  });
});
