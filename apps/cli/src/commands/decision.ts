/**
 * duoctl decision list | confirm <id> | reject <id> | review-pending (T15, T34.2, T44: decision-session.ts). The same core DecisionService as every
 * human surface, with actor { kind: "human", name: Git user.name }. confirm and reject need an
 * interactive terminal and the ID typed again: a guard against unattended runs, not an authentication
 * (docs/10-security.md). Pending proposals come from the listDecisionProposals() read model.
 *
 * Informed confirm (T34.2): before the ID is typed, the full candidate from DecisionService.previewConfirm
 * is shown (content, enforcement and forbids, the superseded target, staleness, the expected Decision ID),
 * and confirm is bound to that preview's digest: if the candidate changed meanwhile, nothing is confirmed.
 */
import { createDecisionService, createDiagnostic, listDecisionProposals, truthAuthorityErrors } from "@duo-director/core";
import { t } from "../messages.js";
import { previewLines } from "./decision-preview.js";
import { reviewPendingCommand } from "./decision-session.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, humanActor, requireProject, usage, type Env } from "./shared.js";

const DECISION_ID = /^D-\d+$/u;
export { previewLines } from "./decision-preview.js";

export async function decisionCommand(env: Env, sub: string | undefined, id: string | undefined, reason: string | undefined): Promise<Outcome> {
  const project = requireProject(env, "decision");
  if (project.value === undefined) return project.outcome as Outcome;
  if (sub === "review-pending") return reviewPendingCommand(env, project.value);
  const truth = project.value.truth;
  const entries = listDecisionProposals(truth);
  if (sub === "list" || sub === undefined) {
    const pending = entries.filter((e) => e.status === "pending");
    const proposedDecisions = truth.decisions.filter((d) => d.state === "proposed");
    // T40 (N1): a proposal or Decision file the loader could not read is named, never just missing from the list.
    const unread = truthAuthorityErrors(project.diagnostics);
    const human = [...(pending.length + proposedDecisions.length === 0 ? [t(env.locale, "decision.none")]
      : [...pending.map((e) => `${e.id}  ${e.proposal.title}  (${e.proposal.question} = ${e.proposal.answer})`), ...proposedDecisions.map((d) => `${d.id}  ${d.title}  (proposed Decision)`)]),
      ...(unread.length === 0 ? [] : [t(env.locale, "decision.truth-errors", { n: unread.length }), ...unread.map((d) => `  ${d.code} ${d.source?.path ?? ""}${d.source?.startLine === undefined ? "" : `:${d.source.startLine}`} ${d.message}`)])];
    return { command: "decision", exitCode: EXIT.OK, diagnostics: unread, human, result: { pending: pending.map((e) => ({ id: e.id, title: e.proposal.title, question: e.proposal.question, answer: e.proposal.answer })), proposedDecisions: proposedDecisions.map((d) => ({ id: d.id, title: d.title })) } };
  }
  if (sub !== "confirm" && sub !== "reject") return usage("decision", "usage: duoctl decision list | confirm <id> | reject <id> [--reason <text>] | review-pending");
  if (id === undefined) return usage("decision", `duoctl decision ${sub} needs an ID`);
  if (!env.io.isTTY || env.nonInteractive) {
    return failed("decision", EXIT.ERROR, [createDiagnostic("CLI_TTY_REQUIRED", t("en", "decision.tty"))], [t(env.locale, "decision.tty")]);
  }
  const service = createDecisionService({ root: env.root, clock: () => env.io.now() });
  // Reject applies to proposals only (DecisionService); a Decision ID goes straight to the service's own refusal after the guard.
  const previewed = sub === "reject" && DECISION_ID.test(id) ? undefined : await service.previewConfirm(id);
  if (previewed !== undefined) {
    if (previewed.value === undefined) return failed("decision", EXIT.ERROR, previewed.diagnostics, diagLines(previewed.diagnostics), null, { status: "failed" });
    for (const line of previewLines(env.locale, previewed.value, sub)) env.io.err(line);
  }
  const typed = (await env.io.prompt(t(env.locale, "decision.retype", { op: sub })))?.trim();
  if (typed !== id) return failed("decision", EXIT.ERROR, [], [t(env.locale, "decision.mismatch")]);
  const actor = await humanActor(env.root);
  if (sub === "confirm") {
    const r = await service.confirm(actor, id, previewed?.value === undefined ? {} : { expectedDigest: previewed.value.digest });
    if (r.value === undefined) return failed("decision", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
    const warnings = r.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.code}: ${d.message}`);
    return {
      command: "decision", exitCode: EXIT.OK, diagnostics: r.diagnostics, result: r.value,
      human: [...warnings, t(env.locale, "decision.confirmed", { id: r.value.decisionId, path: r.value.path }), t(env.locale, "decision.index-hint")], metric: { status: "confirmed" },
    };
  }
  const r = await service.reject(actor, id, reason);
  if (r.value === undefined) return failed("decision", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
  return { command: "decision", exitCode: EXIT.OK, diagnostics: r.diagnostics, result: r.value, human: [t(env.locale, "decision.rejected", { id })], metric: { status: "rejected" } };
}
