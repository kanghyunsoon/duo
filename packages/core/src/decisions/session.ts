/**
 * Confirm session plan (T44, F-07): a person reviews several pending proposals and confirms the chosen ones in one
 * session. Each confirm stays the ordinary DecisionService.confirm, bound to the digest of the candidate the person was
 * shown (T34.2); nothing about authority, locks, provenance or the digest rule changes.
 *
 * Why a plan: confirming one proposal changes Project Truth (a new Decision file), so the proposals after it become
 * stale, and their candidate (and digest) is not the one shown in the first review. planConfirmSession shows the
 * candidates as they will be at the moment each is confirmed: it checks that every proposal is still exactly what was
 * reviewed, then confirms the proposals in order on a temporary copy of .duo-project with the same DecisionService and
 * returns each preview as read right before its confirm. The real confirms are then bound to those digests. A proposal
 * whose result depends on another proposal of the session (it supersedes a Decision this session creates, or two
 * proposals supersede the same Decision) is refused for the whole session: confirm those one at a time.
 *
 * Read-only for the repository: only the temporary copy is written, and it is removed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR_NAME } from "../constants.js";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult, type SourceLocation } from "../diagnostics.js";
import { PROPOSAL_ID_PATTERN } from "../ids.js";
import { compareUtf8 } from "../order.js";
import { createDecisionService, type ConfirmPreview } from "./service.js";

export interface ConfirmSessionItem {
  readonly id: string;
  /** The candidate as it will be when its confirm runs, after the earlier proposals of the session are confirmed. */
  readonly preview: ConfirmPreview;
  /** True when that candidate is not the one reviewed (another digest), e.g. it becomes stale. */
  readonly changedFromReview: boolean;
}

export interface ReviewedProposal {
  readonly id: string;
  /** The digest of the preview the person reviewed. */
  readonly digest: string;
}

/** Regenerable state is not Truth and is not copied. */
const REGENERABLE = new Set(["generated", "cache", "runtime"]);
const PLAN_ACTOR = { kind: "human", name: "confirm-session-plan" } as const;

const conflict = (id: string, reason: string, more: readonly Diagnostic[] = []): ParseResult<never> => failure([
  createDiagnostic("DECISION_SESSION_CONFLICT", `${id} cannot be confirmed in this session after the proposals before it: ${reason}. Nothing was confirmed; confirm it on its own.`),
  ...more,
]);

/** The session order: proposal ID order, the order of every proposal list (listDecisionProposals). */
export function sessionOrder(ids: readonly string[]): string[] {
  return [...ids].sort(compareUtf8);
}

export async function planConfirmSession(options: { readonly root: string }, reviewed: readonly ReviewedProposal[]): Promise<ParseResult<{ readonly items: readonly ConfirmSessionItem[] }>> {
  const ids = reviewed.map((r) => r.id);
  if (ids.length === 0) return failure([createDiagnostic("INVALID_ID", "No proposal was selected")]);
  if (new Set(ids).size !== ids.length) return failure([createDiagnostic("INVALID_ID", "A proposal was selected twice")]);
  const bad = ids.find((id) => !PROPOSAL_ID_PATTERN.test(id));
  if (bad !== undefined) return failure([createDiagnostic("INVALID_ID", `"${bad}" is not a proposal ID; a session confirms proposals only`)]);
  const digestOf = new Map(reviewed.map((r) => [r.id, r.digest]));
  const order = sessionOrder(ids);

  // 1. Every proposal is still exactly what the person reviewed (same rule and message as confirm).
  const live = createDecisionService({ root: options.root });
  for (const id of order) {
    const p = await live.previewConfirm(id);
    if (p.value === undefined) return failure(p.diagnostics);
    if (p.value.sourceKind !== "proposal") return failure([createDiagnostic("INVALID_ID", `${id} is not a proposal`)]);
    if (p.value.digest !== digestOf.get(id)) {
      return failure([createDiagnostic("DECISION_CONFIRM_PREVIEW_CHANGED", "The Decision changed after you reviewed it. Review the current contents and confirm again.", { path: p.value.sourcePath } as SourceLocation)]);
    }
  }

  // 2. Confirm them in order on a copy of the Truth and read each candidate right before its confirm.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-confirm-plan-"));
  try {
    fs.cpSync(path.join(options.root, STATE_DIR_NAME), path.join(tmp, STATE_DIR_NAME), {
      recursive: true,
      filter: (src) => !REGENERABLE.has(path.relative(path.join(options.root, STATE_DIR_NAME), src).split(path.sep)[0] ?? ""),
    });
    const sim = createDecisionService({ root: tmp, clock: () => new Date(0) });
    const created = new Set<string>();
    const items: ConfirmSessionItem[] = [];
    for (const id of order) {
      const p = await sim.previewConfirm(id);
      if (p.value === undefined) return conflict(id, "its candidate cannot be read", p.diagnostics);
      const target = p.value.candidate.supersedes;
      if (typeof target === "string" && created.has(target)) return conflict(id, `it supersedes ${target}, which this session creates`);
      const c = await sim.confirm(PLAN_ACTOR, id, { expectedDigest: p.value.digest });
      if (c.value === undefined) return conflict(id, "its confirm would fail", c.diagnostics);
      created.add(c.value.decisionId);
      items.push({ id, preview: p.value, changedFromReview: p.value.digest !== digestOf.get(id) });
    }
    return success({ items });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
