/**
 * H-80 (C239) through the real pipeline (Context → Gap assessment → rules → aggregate) on the Knowledge Gap fixture:
 * a code-only change with no confirmed intent is PASS and still carries its surfaced missing-intent gap; a keyword task
 * that reaches a pending proposal and related declared UNKNOWNs only by retrieval is still WARN on exactly those gaps.
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, GAP_FIXTURE, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewRequest, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry, GAP_FIXTURE);
  repo.edit("src/tools/format.ts", "out.write(formatBytes(bytes) + \"\\n\");", "out.write(formatBytes(bytes) + \" \\n\");");
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

async function review(request: Omit<ReviewRequest, "diff">): Promise<ReviewResult> {
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(repo.root, { ...request, diff: { from: "HEAD", to: "WORKTREE" } }, { graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  } finally {
    opened.value.close();
  }
}
const shown = (r: ReviewResult) => (r.gaps?.gaps ?? []).filter((g) => g.action !== "ignore");

describe("missing-intent is a surfaced coverage signal in a real Review (H-80)", () => {
  it("a code-only change with no confirmed intent: PASS, the missing-intent gap kept with its fields and metrics", async () => {
    const r = await review({});
    expect(r.status).toBe("ready");
    expect(r.claims).toEqual([]);
    expect(shown(r).map((g) => [g.kind, g.relevance, g.action, g.reasons])).toEqual([["missing-intent", "direct", "surface", [{ code: "no-confirmed-intent" }]]]);
    expect(r.gaps?.requiresHumanInput).toBe(false);
    expect(r.gaps?.primary).toBeUndefined();
    expect(r.gaps?.metrics).toMatchObject({ runtime: 1, direct: 1, surface: 1, ask: 0, llmCalls: 0 });
    expect(r.verdict).toBe("PASS");
    expect(r.verdictBasis).toEqual({ blocking: [], ask: [], warn: [] });
  });

  it("the same change under a keyword task: the retrieved pending proposal and related declared UNKNOWNs still warn", async () => {
    const r = await review({ task: "멀티플레이 서버 확장 구조 설계" });
    const surfaced = shown(r).filter((g) => g.action === "surface");
    expect(surfaced.find((g) => g.kind === "pending-decision")).toMatchObject({ relevance: "related", pending: { id: "P-040" } });
    expect(surfaced.filter((g) => g.kind === "declared").map((g) => g.relevance)).toEqual(["related", "related", "related", "related"]);
    expect(r.gaps?.requiresHumanInput).toBe(false);
    expect(r.verdict).toBe("WARN");
    expect(r.verdictBasis.warn).toEqual(surfaced.filter((g) => g.kind !== "missing-intent").map((g) => g.id));
    expect(r.verdictBasis.warn).toHaveLength(5);
  });
});
