/** Decision and proposal ID allocation (T09): the next number after the largest one in use. */
const DECISION_NUMBER = /^D-(\d+)$/;
const PROPOSAL_NUMBER = /^P-(\d+)$/;

function next(prefix: string, pattern: RegExp, used: Iterable<string>): string {
  let max = 0;
  let width = 3;
  for (const id of used) {
    const m = pattern.exec(id);
    if (m === null) continue;
    const digits = m[1] ?? "0";
    max = Math.max(max, Number(digits));
    width = Math.max(width, digits.length);
  }
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

/** D-### after the largest D-number among the given IDs (ADR-013). */
export function nextDecisionId(used: Iterable<string>): string {
  return next("D", DECISION_NUMBER, used);
}

/** P-### after the largest sequential proposal number (dated P-YYYYMMDD-xxxxxx IDs are ignored). */
export function nextProposalId(used: Iterable<string>): string {
  return next("P", PROPOSAL_NUMBER, used);
}

