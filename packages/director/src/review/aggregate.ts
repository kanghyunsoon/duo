/**
 * Review verdict (TASK-013, ADR-007). BLOCK > ASK > WARN > PASS:
 * - BLOCK: a blockEligible claim (CONFLICT, enforced rule, Project Truth and observable evidence).
 * - ASK: the Knowledge Gap assessment requires human input (C100: the assessment is the authority,
 *   not the Packet flag).
 * - WARN: a PARTIAL, a non-blocking CONFLICT, an UNKNOWN drift signal, or a surfaced gap. Plain
 *   UNKNOWN (a semantic question, a known analysis limit) does not warn, and neither does a violation
 *   that already existed at adoption and this diff did not touch (provenance pre-existing, T14.1).
 * - PASS: none of the above. PASS means DUO found no direction conflict in the evidence it had;
 *   it does not mean the code has no bugs.
 */
import { compareUtf8 } from "@duo-director/core";
import type { KnowledgeGapAssessment } from "../gap/types.js";
import type { ReviewClaim, Verdict } from "./types.js";

export interface VerdictResult {
  readonly verdict: Verdict;
  readonly basis: { readonly blocking: readonly string[]; readonly ask: readonly string[]; readonly warn: readonly string[] };
}

export function reviewVerdict(claims: readonly ReviewClaim[], gaps: KnowledgeGapAssessment | undefined): VerdictResult {
  const blocking = claims.filter((c) => c.blockEligible).map((c) => c.id).sort(compareUtf8);
  const ask = gaps?.requiresHumanInput === true ? gaps.gaps.filter((g) => g.action === "ask").map((g) => g.id) : [];
  const warn = [
    ...claims.filter((c) => !c.blockEligible && c.provenance !== "pre-existing" && (c.alignment === "PARTIAL" || c.alignment === "CONFLICT" || (c.alignment === "UNKNOWN" && c.drift))).map((c) => c.id).sort(compareUtf8),
    ...(gaps?.gaps ?? []).filter((g) => g.action === "surface").map((g) => g.id),
  ];
  const verdict: Verdict = blocking.length > 0 ? "BLOCK" : ask.length > 0 ? "ASK" : warn.length > 0 ? "WARN" : "PASS";
  return { verdict, basis: { blocking, ask, warn } };
}
