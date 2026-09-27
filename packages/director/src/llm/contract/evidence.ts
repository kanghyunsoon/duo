/**
 * Evidence basis and the BLOCK safety rule reserved for Review (TASK-013, ADR-007, ADR-008): a
 * Review-level BLOCK needs explicit Project Truth AND observable repository evidence. LLM output is
 * inferred evidence: it can support or explain a finding, it can raise ASK, but alone (or together
 * with Truth only) it never blocks, and it never replaces a Human-owned Decision.
 */
export type EvidenceBasis = "project-truth" | "repository" | "git" | "test" | "llm";

const OBSERVABLE: ReadonlySet<EvidenceBasis> = new Set(["repository", "git", "test"]);

export function blockEligible(bases: readonly EvidenceBasis[]): boolean {
  return bases.includes("project-truth") && bases.some((b) => OBSERVABLE.has(b));
}
