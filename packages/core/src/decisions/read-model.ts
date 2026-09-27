/**
 * Decision proposal read model (T09.1). UI, CLI, MCP and the Context Compiler ask this one
 * function which proposals are pending; none of them decides it from the files. A proposal file
 * that still exists after its Decision was committed (a confirm whose cleanup has not finished)
 * is committed, not pending: file present ≠ pending. Reading never repairs or writes; repair is
 * the explicit repairDecisionState() mutation.
 */
import type { Decision, ProjectTruth, Proposal } from "../domain/model.js";
import { compareUtf8 } from "../order.js";
import { createDecisionService, type DecisionServiceOptions } from "./service.js";
import type { ParseResult } from "../diagnostics.js";

export type ProposalStatus = "pending" | "rejected" | "committed";

export interface DecisionProposalEntry {
  readonly id: string;
  readonly status: ProposalStatus;
  readonly proposal: Proposal;
  /** For committed proposals: the Decision that records this proposal as its source. */
  readonly decisionId?: string;
  /** Committed but the proposal file is still there: repairDecisionState() removes it. */
  readonly cleanupPending?: boolean;
}

/**
 * Status of every proposal file. pending = state proposed AND no Decision names it as its proposal;
 * committed = some Decision names it; rejected = state rejected (and not committed). ID order.
 */
export function listDecisionProposals(truth: Pick<ProjectTruth, "proposals" | "decisions">): DecisionProposalEntry[] {
  const committedBy = new Map<string, Decision>();
  for (const d of truth.decisions) if (d.proposalId !== undefined && !committedBy.has(d.proposalId)) committedBy.set(d.proposalId, d);
  return [...truth.proposals].sort((a, b) => compareUtf8(a.id, b.id)).map((proposal) => {
    const decision = committedBy.get(proposal.id);
    if (decision !== undefined) return { id: proposal.id, status: "committed" as const, proposal, decisionId: decision.id, cleanupPending: true };
    return { id: proposal.id, status: proposal.state === "rejected" ? "rejected" as const : "pending" as const, proposal };
  });
}

/** Only the proposals a human still has to decide. */
export function pendingDecisionProposals(truth: Pick<ProjectTruth, "proposals" | "decisions">): Proposal[] {
  return listDecisionProposals(truth).filter((e) => e.status === "pending").map((e) => e.proposal);
}

/** Explicit mutation: finishes interrupted confirms (removes committed proposal files, marks superseded targets). */
export async function repairDecisionState(options: DecisionServiceOptions): Promise<ParseResult<{ readonly repaired: readonly string[] }>> {
  return createDecisionService(options).repair();
}

