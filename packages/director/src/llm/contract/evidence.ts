/**
 * The BLOCK safety rule (TASK-012A, applied by Review in TASK-013; ADR-007, ADR-008): a Review-level
 * BLOCK needs explicit Project Truth AND observable repository evidence. LLM output is inferred
 * evidence: it can support or explain a finding, it can raise a warning, but alone (or together with
 * Truth only) it never blocks, and it never replaces a Human-owned Decision.
 */
import type { EvidenceBasis } from "@duo-director/core";

export type { EvidenceBasis };

const OBSERVABLE: ReadonlySet<EvidenceBasis> = new Set(["repository", "git", "test"]);

export function blockEligible(bases: readonly EvidenceBasis[]): boolean {
  return bases.includes("project-truth") && bases.some((b) => OBSERVABLE.has(b));
}
