/**
 * duoctl decision list | confirm <id> | reject <id> (T15). The same core DecisionService as every
 * human surface, with actor { kind: "human", name: Git user.name }. confirm and reject need an
 * interactive terminal and the ID typed again: a guard against unattended runs, not an authentication
 * (docs/10-security.md). Pending proposals come from the listDecisionProposals() read model.
 */
import { createDecisionService, listDecisionProposals } from "@duo-director/core";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, humanActor, requireProject, usage, type Env } from "./shared.js";
import { createDiagnostic } from "@duo-director/core";

export async function decisionCommand(env: Env, sub: string | undefined, id: string | undefined, reason: string | undefined): Promise<Outcome> {
  const project = requireProject(env, "decision");
  if (project.value === undefined) return project.outcome as Outcome;
  const truth = project.value.truth;
  const entries = listDecisionProposals(truth);
  if (sub === "list" || sub === undefined) {
    const pending = entries.filter((e) => e.status === "pending");
    const proposedDecisions = truth.decisions.filter((d) => d.state === "proposed");
    const human = pending.length + proposedDecisions.length === 0 ? [t(env.locale, "decision.none")]
      : [...pending.map((e) => `${e.id}  ${e.proposal.title}  (${e.proposal.question} = ${e.proposal.answer})`), ...proposedDecisions.map((d) => `${d.id}  ${d.title}  (proposed Decision)`)];
    return { command: "decision", exitCode: EXIT.OK, diagnostics: [], human, result: { pending: pending.map((e) => ({ id: e.id, title: e.proposal.title, question: e.proposal.question, answer: e.proposal.answer })), proposedDecisions: proposedDecisions.map((d) => ({ id: d.id, title: d.title })) } };
  }
  if (sub !== "confirm" && sub !== "reject") return usage("decision", "usage: duoctl decision list | confirm <id> | reject <id> [--reason <text>]");
  if (id === undefined) return usage("decision", `duoctl decision ${sub} needs an ID`);
  if (!env.io.isTTY || env.nonInteractive) {
    return failed("decision", EXIT.ERROR, [createDiagnostic("CLI_TTY_REQUIRED", t("en", "decision.tty"))], [t(env.locale, "decision.tty")]);
  }
  const proposal = entries.find((e) => e.id === id);
  const decision = truth.decisions.find((d) => d.id === id);
  const shown = proposal?.proposal ?? decision;
  if (shown !== undefined) {
    env.io.err(`${id}  "${shown.title}"`);
    env.io.err(`  question  ${shown.question}`);
    env.io.err(`  answer    ${shown.answer}`);
    if (shown.governs.requirements.length > 0) env.io.err(`  governs   ${shown.governs.requirements.join(", ")}`);
  }
  const typed = (await env.io.prompt(t(env.locale, "decision.retype", { op: sub })))?.trim();
  if (typed !== id) return failed("decision", EXIT.ERROR, [], [t(env.locale, "decision.mismatch")]);
  const service = createDecisionService({ root: env.root, clock: () => env.io.now() });
  const actor = await humanActor(env.root);
  if (sub === "confirm") {
    const r = await service.confirm(actor, id);
    if (r.value === undefined) return failed("decision", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
    const warnings = r.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.code}: ${d.message}`);
    return { command: "decision", exitCode: EXIT.OK, diagnostics: r.diagnostics, result: r.value, human: [...warnings, t(env.locale, "decision.confirmed", { id: r.value.decisionId, path: r.value.path })], metric: { status: "confirmed" } };
  }
  const r = await service.reject(actor, id, reason);
  if (r.value === undefined) return failed("decision", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
  return { command: "decision", exitCode: EXIT.OK, diagnostics: r.diagnostics, result: r.value, human: [t(env.locale, "decision.rejected", { id })], metric: { status: "rejected" } };
}
