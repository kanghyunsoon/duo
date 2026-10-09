/**
 * C241 (T49): a claim about a Decision carries that Decision's lifecycle facts from Project Truth, and nothing else
 * about the claim or the Review Record changes.
 */
import type { Decision, ProjectTruth } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { AUTHORITY_LABELS, decisionAuthorityLabel, decisionAuthorityParts } from "./authority-label.js";
import { isActive, withDecisionAuthority } from "./claims.js";
import { reviewRecordBody } from "./record.js";
import type { ReviewClaim, ReviewResult } from "./types.js";

const decision = (id: string, state: Decision["state"], supersedes: string | null, supersededBy: string | null) =>
  ({ id, state, supersedes, supersededBy }) as unknown as Decision;
const truth = (...decisions: Decision[]) => ({ decisions }) as Pick<ProjectTruth, "decisions">;
const claim = (rule: ReviewClaim["rule"], kind: string, id: string): ReviewClaim => ({
  id: "claim-" + rule + "-" + id, rule, subject: { kind, id }, expected: "e", observed: "o", alignment: "CONFLICT", evidenceIds: ["ev-1"], basis: ["project-truth"],
  reason: "r", enforced: true, blockEligible: true, drift: false, semanticCandidate: false, violationKey: "k", provenance: "introduced",
});

describe("Decision authority on Review claims (C241)", () => {
  const T = truth(
    decision("D-001", "superseded", null, "D-002"),
    decision("D-002", "confirmed", "D-001", null),
    decision("D-003", "confirmed", null, null),
  );

  it("A, B, C: current with and without supersedes, and a superseded Decision", () => {
    const [a, b, c] = withDecisionAuthority(T, [claim("decision-governance", "decision", "D-003"), claim("decision-forbids", "decision", "D-002"), claim("decision-integrity", "decision", "D-001")]);
    expect(a?.decisionAuthority).toEqual({ state: "confirmed", active: true, supersedes: null, supersededBy: null });
    expect(b?.decisionAuthority).toEqual({ state: "confirmed", active: true, supersedes: "D-001", supersededBy: null });
    expect(c?.decisionAuthority).toEqual({ state: "superseded", active: false, supersedes: null, supersededBy: "D-002" });
  });

  it("D, E: no metadata for non-Decision claims, an intent Constraint with a Decision's ID, or a Decision not in Truth", () => {
    const others = [claim("test-coverage", "requirement", "REQ-001"), claim("scope-relevance", "file", "src/a.ts"), claim("constraint-compliance", "constraint", "D-002"), claim("decision-integrity", "decision", "D-404")];
    const out = withDecisionAuthority(T, others);
    for (const [i, c] of out.entries()) {
      expect(c.decisionAuthority).toBeUndefined();
      expect(c).toBe(others[i]);
    }
  });

  it("only the new field is added: ID, rule, alignment, evidence, enforcement and provenance are the same", () => {
    const before = claim("decision-forbids", "decision", "D-002");
    const [after] = withDecisionAuthority(T, [before]);
    const { decisionAuthority, ...rest } = after as ReviewClaim;
    expect(decisionAuthority).toBeDefined();
    expect(rest).toEqual(before);
  });

  it("active is the rules' own test (isActive); an inconsistent lifecycle is shown as Truth has it", () => {
    const odd = truth(decision("D-001", "confirmed", null, null), decision("D-002", "confirmed", "D-001", null), decision("D-004", "confirmed", null, "D-005"), decision("D-006", "proposed", null, null));
    const out = withDecisionAuthority(odd, ["D-001", "D-002", "D-004", "D-006"].map((id) => claim("supersede-integrity", "decision", id)));
    expect(out.map((c) => c.decisionAuthority)).toEqual([
      { state: "confirmed", active: true, supersedes: null, supersededBy: null },
      { state: "confirmed", active: true, supersedes: "D-001", supersededBy: null },
      { state: "confirmed", active: false, supersedes: null, supersededBy: "D-005" },
      { state: "proposed", active: false, supersedes: null, supersededBy: null },
    ]);
    for (const d of odd.decisions) expect(out.find((c) => c.subject.id === d.id)?.decisionAuthority?.active).toBe(isActive(d));
  });

  it("human wording: current authority, supersedes, superseded by, in en and ko; only direct relations", () => {
    expect(decisionAuthorityLabel({ state: "confirmed", active: true, supersedes: null, supersededBy: null })).toBe("current authority");
    expect(decisionAuthorityLabel({ state: "confirmed", active: true, supersedes: "D-002", supersededBy: null })).toBe("current authority · supersedes D-002");
    expect(decisionAuthorityLabel({ state: "superseded", active: false, supersedes: "D-001", supersededBy: "D-003" })).toBe("superseded · supersedes D-001 · superseded by D-003");
    expect(decisionAuthorityParts({ state: "confirmed", active: false, supersedes: null, supersededBy: "D-005" })).toEqual(["not current authority (confirmed)", "superseded by D-005"]);
    expect(decisionAuthorityLabel({ state: "confirmed", active: true, supersedes: "D-001", supersededBy: null }, "ko")).toBe("현재 authority · 대체 대상 D-001");
    expect(decisionAuthorityLabel({ state: "superseded", active: false, supersedes: null, supersededBy: "D-002" }, "ko")).toBe("대체됨 · 대체한 Decision D-002");
    expect(Object.keys(AUTHORITY_LABELS.ko)).toEqual(Object.keys(AUTHORITY_LABELS.en));
  });

  it("the Review Record body is the same with or without the lifecycle facts", () => {
    const claims = [claim("decision-forbids", "decision", "D-002"), claim("test-coverage", "requirement", "REQ-001")];
    const result = {
      format: "duo.review/1", status: "ready", request: { identity: "i", task: "", from: "a", to: "b" }, baseline: { status: "missing" },
      freshness: { status: "current", fullRebuildRequired: false }, diff: { identity: "d", from: "a", to: "b", files: [] }, seeds: [], verdict: "BLOCK",
      verdictBasis: { blocking: [claims[0]?.id], ask: [], warn: [] }, claims, evidence: [], limitations: [], diagnostics: [],
    } as unknown as ReviewResult;
    const withAuthority = { ...result, claims: withDecisionAuthority(T, claims) };
    expect(withAuthority.claims[0]?.decisionAuthority).toBeDefined();
    expect(JSON.stringify(reviewRecordBody(withAuthority))).toBe(JSON.stringify(reviewRecordBody(result)));
    expect(JSON.stringify(reviewRecordBody(withAuthority))).not.toContain("decisionAuthority");
  });
});
