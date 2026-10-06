/**
 * duoctl decision list | confirm <id> | reject <id> (T15, T34.2). The same core DecisionService as every
 * human surface, with actor { kind: "human", name: Git user.name }. confirm and reject need an
 * interactive terminal and the ID typed again: a guard against unattended runs, not an authentication
 * (docs/10-security.md). Pending proposals come from the listDecisionProposals() read model.
 *
 * Informed confirm (T34.2): before the ID is typed, the full candidate from DecisionService.previewConfirm
 * is shown (content, enforcement and forbids, the superseded target, staleness, the expected Decision ID),
 * and confirm is bound to that preview's digest: if the candidate changed meanwhile, nothing is confirmed.
 */
import { createDecisionService, createDiagnostic, listDecisionProposals, truthAuthorityErrors, type ConfirmPreview } from "@duo-director/core";
import { t, type Locale } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, humanActor, requireProject, usage, type Env } from "./shared.js";

const DECISION_ID = /^D-\d+$/u;
const LABEL_WIDTH = 13;

/** A field value as the file has it: absent → (not set), empty → (none). Nothing is defaulted or reinterpreted. */
function show(L: Locale, value: unknown, nested = false): string {
  if (value === undefined || value === null) return t(L, "decision.preview.not-set");
  if (Array.isArray(value)) return value.length === 0 ? t(L, "decision.preview.none") : value.map((v) => show(L, v, true)).join(", ");
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}: ${show(L, v, true)}`);
    if (parts.length === 0) return t(L, "decision.preview.none");
    return nested ? `{${parts.join("; ")}}` : parts.join("; ");
  }
  return String(value).replace(/\r?\n/gu, `\n${" ".repeat(LABEL_WIDTH + 3)}`);
}

/** True when the candidate's forbids has at least one entry. */
function hasForbids(forbids: unknown): boolean {
  return typeof forbids === "object" && forbids !== null && Object.values(forbids as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
}

/** The candidate a confirm or reject acts on, as lines for stderr. */
export function previewLines(L: Locale, p: ConfirmPreview, op: "confirm" | "reject"): string[] {
  const c = p.candidate;
  const id = p.sourceId;
  const head = op === "reject" ? t(L, "decision.preview.reject", { id })
    : p.action === "create" ? t(L, "decision.preview.create", { id })
      : p.action === "add-lock" ? t(L, "decision.preview.lock", { id }) : t(L, "decision.preview.in-place", { id });
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)} ${value}`;
  const supersedes = c.supersedes === undefined ? t(L, "decision.preview.not-set")
    : p.supersedes === undefined ? `${show(L, c.supersedes)} (${t(L, "decision.preview.not-found")})`
      : `${p.supersedes.id} "${p.supersedes.title}" (${p.supersedes.state})${op === "confirm" ? ` → ${t(L, "decision.preview.becomes-superseded")}` : ""}`;
  // Staleness applies to proposals only; for a YAML Decision it is "not applicable", never "no" (T34.3).
  const stale = p.sourceKind === "decision" ? t(L, "decision.preview.stale-na")
    : p.stale === undefined ? t(L, "decision.preview.fresh")
    : t(L, "decision.preview.stale", { changed: p.stale.changedRefs.length > 0 ? ` (changed: ${p.stale.changedRefs.join(", ")})` : "" });
  const lines = [
    head,
    row("Title", show(L, c.title)), row("Question", show(L, c.question)), row("Answer", show(L, c.answer)), row("Kind", show(L, c.kind)),
    row("Rationale", show(L, c.rationale)), row("Governs", show(L, c.governs)), row("Forbids", show(L, c.forbids)),
    // T40 (N3): governs does not scope forbids; say so wherever forbids are set.
    ...(hasForbids(c.forbids) ? [row("Forbids scope", t(L, "decision.preview.forbids-scope"))] : []),
    row("Enforcement", show(L, c.enforcement)),
    row("Supersedes", supersedes),
    // H-71: the proposer as the proposal file records it (an audit label); a YAML Decision has none to show.
    ...(p.sourceKind === "proposal" ? [row("Proposed by", p.proposedBy === undefined ? t(L, "decision.preview.not-set") : `${p.proposedBy}${p.proposedByKind === undefined ? "" : ` (${p.proposedByKind})`}`)] : []),
    ...(c.evidence === undefined ? [] : [row("Evidence", show(L, c.evidence))]),
    ...(c.source === undefined ? [] : [row("Source", show(L, c.source))]),
    ...(c.extensions === undefined ? [] : [row("Extensions", show(L, c.extensions))]),
    row("Stale", stale),
  ];
  if (op === "confirm") {
    const expected = p.action === "create" ? t(L, "decision.preview.expected", { id: p.expectedDecisionId })
      : p.action === "add-lock" ? t(L, "decision.preview.lock-id", { id: p.expectedDecisionId }) : t(L, "decision.preview.in-place-id", { id: p.expectedDecisionId });
    lines.push(row("Expected ID", expected));
  }
  lines.push(row("File", p.sourcePath));
  return lines;
}

export async function decisionCommand(env: Env, sub: string | undefined, id: string | undefined, reason: string | undefined): Promise<Outcome> {
  const project = requireProject(env, "decision");
  if (project.value === undefined) return project.outcome as Outcome;
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
  if (sub !== "confirm" && sub !== "reject") return usage("decision", "usage: duoctl decision list | confirm <id> | reject <id> [--reason <text>]");
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
