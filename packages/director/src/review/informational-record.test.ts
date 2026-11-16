/**
 * #59 C259 (H-100): an informational claim keeps `informational: true` in the Review Record body; other claims
 * carry no such field.
 */
import { describe, expect, it } from "vitest";
import { reviewRecordBody } from "./record.js";
import type { ReviewClaim, ReviewResult } from "./types.js";

const claim = (id: string, extra: Partial<ReviewClaim> = {}): ReviewClaim => ({
  id, rule: "requirement-implementation", subject: { kind: "file", id: "src/name.ts" }, expected: "e", observed: "REQ-001, REQ-003", alignment: "PARTIAL",
  evidenceIds: ["ev-1"], basis: ["project-truth"], reason: "outside-current-milestone", enforced: false, blockEligible: false, drift: false, semanticCandidate: false,
  ...extra,
});

describe("Review Record body and informational claims (H-100)", () => {
  it("keeps informational: true on an informational claim and adds nothing to the others", () => {
    const claims = [claim("claim-info", { informational: true }), claim("claim-other", { rule: "test-coverage", subject: { kind: "requirement", id: "REQ-001" }, reason: "r" })];
    const result = {
      format: "duo.review/1", status: "ready", request: { identity: "i", task: "", from: "a", to: "b" }, baseline: { status: "missing" },
      freshness: { status: "current", fullRebuildRequired: false }, diff: { identity: "d", from: "a", to: "b", files: [] }, seeds: [], verdict: "WARN",
      verdictBasis: { blocking: [], ask: [], warn: ["claim-other"] }, claims, evidence: [], limitations: [], diagnostics: [],
    } as unknown as ReviewResult;
    const body = reviewRecordBody(result) as { claims: Record<string, unknown>[] };
    expect(body.claims[0]).toMatchObject({ id: "claim-info", informational: true });
    expect(body.claims[1]).not.toHaveProperty("informational");
  });
});
