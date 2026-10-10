/**
 * H-80 (C239): reviewVerdict maps gaps to the verdict. A surfaced missing-intent gap is a coverage signal and is not
 * by itself a WARN basis; every other surfaced gap still warns, ASK and BLOCK are unchanged, and the assessment
 * (gaps, actions, metrics) is not touched.
 */
import { describe, expect, it } from "vitest";
import type { GapAction, GapKind, GapReasonCode, GapRelevance, KnowledgeGap, KnowledgeGapAssessment } from "../gap/types.js";
import { reviewVerdict } from "./aggregate.js";
import type { ReviewClaim } from "./types.js";

const claim = (id: string, over: Partial<ReviewClaim> = {}): ReviewClaim => ({
  id, rule: "decision-forbids", subject: { kind: "decision", id: "D-001" }, expected: "", observed: "", alignment: "ALIGNED",
  evidenceIds: ["ev-0000000000000001"], basis: [], reason: "test", enforced: false, blockEligible: false, drift: false, semanticCandidate: false, ...over,
});
const gap = (id: string, kind: GapKind, action: GapAction, relevance: GapRelevance, code: GapReasonCode): KnowledgeGap => ({
  id, source: kind === "declared" ? "declared" : "runtime", kind, anchors: [], relevance, reasons: [{ code }], action,
});
const MISSING = gap("rgap-missing", "missing-intent", "surface", "direct", "no-confirmed-intent");
const NO_SEED = gap("rgap-noseed", "missing-intent", "surface", "direct", "no-seed");
const PENDING = gap("rgap-pending", "pending-decision", "surface", "related", "retrieved-seed");
const DECLARED = gap("gap-declared", "declared", "surface", "related", "retrieved-seed");
const UNRESOLVED = gap("rgap-unresolved", "unresolved-target", "ask", "direct", "unresolved-id");

function assessment(gaps: readonly KnowledgeGap[]): KnowledgeGapAssessment {
  const asks = gaps.filter((g) => g.action === "ask").map((g) => g.id);
  const count = (f: (g: KnowledgeGap) => boolean) => gaps.filter(f).length;
  return {
    format: "duo.gap-assessment/1", status: "assessed", gaps, requiresHumanInput: asks.length > 0,
    ...(asks[0] === undefined ? {} : { primary: asks[0] }), additional: asks.slice(1), technicalLimitations: [],
    metrics: {
      declaredConsidered: count((g) => g.source === "declared"), runtime: count((g) => g.source === "runtime"),
      direct: count((g) => g.relevance === "direct"), related: count((g) => g.relevance === "related"), none: count((g) => g.relevance === "none"),
      ask: asks.length, surface: count((g) => g.action === "surface"), ignore: count((g) => g.action === "ignore"), llmCalls: 0,
    },
  };
}

describe("reviewVerdict: missing-intent is surfaced, not a WARN basis (H-80)", () => {
  it("a surfaced missing-intent gap alone (either reason) is PASS with an empty basis", () => {
    for (const g of [MISSING, NO_SEED]) {
      expect(reviewVerdict([], assessment([g]))).toEqual({ verdict: "PASS", basis: { blocking: [], ask: [], warn: [] } });
      expect(reviewVerdict([claim("claim-aligned")], assessment([g])).verdict).toBe("PASS");
    }
  });

  it("a surfaced pending Decision reached only by retrieval still warns", () => {
    expect(reviewVerdict([], assessment([PENDING]))).toEqual({ verdict: "WARN", basis: { blocking: [], ask: [], warn: ["rgap-pending"] } });
  });

  it("a surfaced related declared UNKNOWN still warns", () => {
    expect(reviewVerdict([], assessment([DECLARED]))).toEqual({ verdict: "WARN", basis: { blocking: [], ask: [], warn: ["gap-declared"] } });
  });

  it("missing-intent with a non-blocking WARN claim is WARN on the claim only", () => {
    const touched = claim("claim-touched", { alignment: "CONFLICT", provenance: "pre-existing-touched" });
    expect(reviewVerdict([touched], assessment([MISSING]))).toEqual({ verdict: "WARN", basis: { blocking: [], ask: [], warn: ["claim-touched"] } });
  });

  it("missing-intent with a blocking claim is BLOCK; the gap is not in any basis", () => {
    const blocking = claim("claim-block", { alignment: "CONFLICT", enforced: true, blockEligible: true, provenance: "introduced" });
    const touched = claim("claim-touched", { alignment: "CONFLICT", provenance: "pre-existing-touched" });
    expect(reviewVerdict([blocking, touched], assessment([MISSING]))).toEqual({ verdict: "BLOCK", basis: { blocking: ["claim-block"], ask: [], warn: ["claim-touched"] } });
  });

  it("missing-intent with an ask gap is ASK on the ask gap only", () => {
    expect(reviewVerdict([], assessment([UNRESOLVED, MISSING]))).toEqual({ verdict: "ASK", basis: { blocking: [], ask: ["rgap-unresolved"], warn: [] } });
  });

  it("verdictBasis.warn leaves out exactly the missing-intent gaps and keeps every other surfaced gap in order", () => {
    const all = assessment([PENDING, DECLARED, MISSING, NO_SEED]);
    expect(reviewVerdict([], all)).toEqual({ verdict: "WARN", basis: { blocking: [], ask: [], warn: ["rgap-pending", "gap-declared"] } });
  });

  it("the assessment is not changed: gaps, actions and metrics stay as assessed", () => {
    const a = assessment([UNRESOLVED, PENDING, DECLARED, MISSING]);
    const before = JSON.stringify(a);
    reviewVerdict([], a);
    expect(JSON.stringify(a)).toBe(before);
    expect(a.gaps.find((g) => g.kind === "missing-intent")).toMatchObject({ action: "surface", relevance: "direct", reasons: [{ code: "no-confirmed-intent" }] });
    expect(a.metrics).toMatchObject({ runtime: 3, surface: 3, ask: 1, direct: 2, related: 2 });
  });
});
