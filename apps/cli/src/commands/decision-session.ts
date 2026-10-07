/**
 * duoctl decision review-pending (T44, F-07): one terminal session in which a person reviews every pending proposal
 * and confirms the ones they choose. Human-only and terminal-only like confirm: the actor is the Git user, a
 * non-terminal or --non-interactive run is refused, nothing has a default answer, and no agent or MCP tool can start it.
 *
 * 1. Every pending proposal is shown with the full informed-confirm preview, in ID order.
 * 2. The person types the IDs to confirm, "all", "one" (decide one by one) or nothing (cancel).
 * 3. all / IDs: core planConfirmSession reads each candidate as it will be when its confirm runs (confirming an
 *    earlier proposal makes the later ones stale) and refuses proposals that depend on each other. Rows that change
 *    are shown, then the person types the chosen IDs again. Each confirm is the ordinary DecisionService.confirm,
 *    bound to the digest of the candidate shown; one that changed meanwhile fails on its own
 *    (DECISION_CONFIRM_PREVIEW_CHANGED) and the others go on. There is no session transaction and no new authority:
 *    every Decision is confirmed exactly as with duoctl decision confirm.
 * 4. one: each proposal is read again right before its prompt; if it changed since the review, the changed rows are
 *    shown first, and its ID is typed to confirm it, "skip" leaves it pending, nothing stops the session.
 */
import { createDecisionService, createDiagnostic, listDecisionProposals, planConfirmSession, sessionOrder, type ConfirmPreview, type Diagnostic, type LoadedProject } from "@duo-director/core";
import { t, type Locale } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { previewLines } from "./decision-preview.js";
import { diagLines, humanActor, type Env } from "./shared.js";

export type Selection =
  | { readonly kind: "cancel" }
  | { readonly kind: "all" }
  | { readonly kind: "one" }
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | { readonly kind: "error"; readonly reason: "unknown-id" | "duplicate-id" | "mixed"; readonly id?: string };

const tokens = (input: string) => input.split(/[\s,]+/u).filter((x) => x !== "").map((x) => (/^p-/iu.test(x) ? x.toUpperCase() : x.toLowerCase()));

/** The answer to the selection prompt. Empty or ended input cancels; nothing is chosen by default. */
export function parseSelection(input: string | undefined, pending: readonly string[]): Selection {
  const list = tokens(input ?? "");
  if (list.length === 0) return { kind: "cancel" };
  if (list.length === 1 && (list[0] === "all" || list[0] === "one" || list[0] === "cancel")) return { kind: list[0] as "all" | "one" | "cancel" };
  if (list.some((x) => x === "all" || x === "one" || x === "cancel")) return { kind: "error", reason: "mixed" };
  const seen = new Set<string>();
  for (const id of list) {
    if (seen.has(id)) return { kind: "error", reason: "duplicate-id", id };
    seen.add(id);
    if (!pending.includes(id)) return { kind: "error", reason: "unknown-id", id };
  }
  return { kind: "ids", ids: sessionOrder(list) };
}

/** The final retype: the chosen IDs, in the order shown. */
export function matchesSelection(input: string | undefined, selected: readonly string[]): boolean {
  const list = tokens(input ?? "");
  return list.length === selected.length && list.every((x, i) => x === selected[i]);
}

/** Rows of a preview that differ from the one reviewed (the Expected ID row is shown in the plan). */
export function changedRows(before: readonly string[], after: readonly string[]): string[] {
  const key = (line: string) => (line.startsWith("  ") ? line.slice(2, 15).trim() : "");
  const rows = (lines: readonly string[]) => new Map(lines.slice(1).map((l) => [key(l), l] as const).filter(([k]) => k !== "" && k !== "Expected ID"));
  const a = rows(before);
  const b = rows(after);
  const out: string[] = [];
  for (const [k, line] of b) {
    const old = a.get(k);
    if (old !== line) out.push(...(old === undefined ? [] : ["  - " + old.trim()]), "  + " + line.trim());
  }
  for (const [k, line] of a) if (!b.has(k)) out.push("  - " + line.trim());
  return out;
}

interface SessionResult {
  mode: "all" | "ids" | "one" | "cancel";
  reviewed: string[];
  selected: string[];
  confirmed: { proposalId: string; decisionId: string; path: string }[];
  skipped: string[];
  failed: { proposalId: string; diagnostics: string[] }[];
  pending: string[];
}

export async function reviewPendingCommand(env: Env, project: LoadedProject): Promise<Outcome> {
  const L: Locale = env.locale;
  if (!env.io.isTTY || env.nonInteractive) {
    return failed("decision", EXIT.ERROR, [createDiagnostic("CLI_TTY_REQUIRED", t("en", "decision.tty"))], [t(L, "decision.tty")]);
  }
  const pendingIds = listDecisionProposals(project.truth).filter((e) => e.status === "pending").map((e) => e.id);
  const service = createDecisionService({ root: env.root, clock: () => env.io.now() });
  const res: SessionResult = { mode: "cancel", reviewed: [], selected: [], confirmed: [], skipped: [], failed: [], pending: [] };
  const outcome = (exitCode: number, human: string[], diagnostics: readonly Diagnostic[] = [], status?: string): Outcome => {
    const confirmedIds = new Set(res.confirmed.map((c) => c.proposalId));
    res.pending = res.reviewed.filter((id) => !confirmedIds.has(id));
    const st = status ?? (res.failed.length > 0 ? "partial" : res.confirmed.length > 0 ? "confirmed" : "cancelled");
    return { command: "decision", exitCode, diagnostics, human, result: { status: st, session: res }, metric: { status: st } };
  };
  if (pendingIds.length === 0) return outcome(EXIT.OK, [t(L, "decision.none")], [], "none");

  // 1. Review: the full preview of every pending proposal (read-only; a Truth that cannot be read fails here).
  const reviewed = new Map<string, ConfirmPreview>();
  for (const id of pendingIds) {
    const p = await service.previewConfirm(id);
    if (p.value === undefined) return failed("decision", EXIT.ERROR, p.diagnostics, diagLines(p.diagnostics), null, { status: "failed" });
    reviewed.set(id, p.value);
  }
  res.reviewed = [...pendingIds];
  env.io.err(t(L, "decision.session.header", { n: pendingIds.length, ids: pendingIds.join(", ") }));
  pendingIds.forEach((id, i) => {
    env.io.err("");
    env.io.err(t(L, "decision.session.item", { i: i + 1, n: pendingIds.length }));
    for (const line of previewLines(L, reviewed.get(id) as ConfirmPreview, "confirm")) env.io.err(line);
  });
  env.io.err("");

  // 2. Selection.
  const sel = parseSelection(await env.io.prompt(t(L, "decision.session.select", { example: pendingIds.slice(0, 2).join(" ") })), pendingIds);
  if (sel.kind === "cancel") return outcome(EXIT.OK, [t(L, "decision.session.cancelled")]);
  if (sel.kind === "error") {
    const reason = sel.reason === "mixed" ? t(L, "decision.session.mixed") : t(L, sel.reason === "unknown-id" ? "decision.session.unknown-id" : "decision.session.duplicate-id", { id: sel.id ?? "" });
    return outcome(EXIT.ERROR, [t(L, "decision.session.select-invalid", { reason })], [], "failed");
  }
  const actor = await humanActor(env.root);

  if (sel.kind === "one") {
    res.mode = "one";
    res.selected = [...pendingIds];
    for (const id of pendingIds) {
      const p = await service.previewConfirm(id);
      if (p.value === undefined) {
        res.failed.push({ proposalId: id, diagnostics: p.diagnostics.map((d) => d.code) });
        return outcome(EXIT.ERROR, [...diagLines(p.diagnostics), t(L, "decision.session.stopped")], p.diagnostics);
      }
      const rows = changedRows(previewLines(L, reviewed.get(id) as ConfirmPreview, "confirm"), previewLines(L, p.value, "confirm"));
      if (p.value.digest !== reviewed.get(id)?.digest) {
        env.io.err(t(L, "decision.session.one-changed", { id }));
        for (const r of rows) env.io.err(r);
      }
      const answer = (await env.io.prompt(t(L, "decision.session.one-prompt", { id, expected: p.value.expectedDecisionId })))?.trim() ?? "";
      if (answer === "") return outcome(res.failed.length > 0 ? EXIT.ERROR : EXIT.OK, [...summary(L, res), t(L, "decision.session.stopped")]);
      if (answer.toLowerCase() === "skip") { res.skipped.push(id); env.io.err(t(L, "decision.session.skipped", { id })); continue; }
      if (answer.toUpperCase() !== id) return outcome(EXIT.ERROR, [...summary(L, res), t(L, "decision.mismatch"), t(L, "decision.session.stopped")]);
      const r = await service.confirm(actor, id, { expectedDigest: p.value.digest });
      if (r.value === undefined) {
        res.failed.push({ proposalId: id, diagnostics: r.diagnostics.map((d) => d.code) });
        for (const line of [t(L, "decision.session.failed-item", { id }), ...diagLines(r.diagnostics)]) env.io.err(line);
        continue;
      }
      res.confirmed.push({ proposalId: id, decisionId: r.value.decisionId, path: r.value.path });
      env.io.err(t(L, "decision.confirmed", { id: r.value.decisionId, path: r.value.path }));
    }
    return outcome(res.failed.length > 0 ? EXIT.ERROR : EXIT.OK, summary(L, res));
  }

  // 3. all / IDs: the plan shows each candidate as it will be when its confirm runs.
  res.mode = sel.kind;
  const selected = sel.kind === "all" ? [...pendingIds] : [...sel.ids];
  res.selected = selected;
  const plan = await planConfirmSession({ root: env.root }, selected.map((id) => ({ id, digest: (reviewed.get(id) as ConfirmPreview).digest })));
  if (plan.value === undefined) return outcome(EXIT.ERROR, [...diagLines(plan.diagnostics), t(L, "decision.session.nothing")], plan.diagnostics, "failed");
  env.io.err(t(L, "decision.session.plan"));
  for (const item of plan.value.items) env.io.err(t(L, "decision.session.plan-item", { id: item.id, decision: item.preview.expectedDecisionId }));
  for (const item of plan.value.items.filter((x) => x.changedFromReview)) {
    env.io.err("");
    env.io.err(t(L, "decision.session.changed", { id: item.id }));
    for (const r of changedRows(previewLines(L, reviewed.get(item.id) as ConfirmPreview, "confirm"), previewLines(L, item.preview, "confirm"))) env.io.err(r);
  }
  env.io.err("");
  const typed = await env.io.prompt(t(L, "decision.session.final", { ids: selected.join(" ") }));
  if ((typed ?? "").trim() === "") return outcome(EXIT.OK, [t(L, "decision.session.cancelled")]);
  if (!matchesSelection(typed, selected)) return outcome(EXIT.ERROR, [t(L, "decision.session.final-mismatch")], [], "failed");
  for (const item of plan.value.items) {
    const r = await service.confirm(actor, item.id, { expectedDigest: item.preview.digest });
    if (r.value === undefined) {
      res.failed.push({ proposalId: item.id, diagnostics: r.diagnostics.map((d) => d.code) });
      for (const line of [t(L, "decision.session.failed-item", { id: item.id }), ...diagLines(r.diagnostics)]) env.io.err(line);
      continue;
    }
    res.confirmed.push({ proposalId: item.id, decisionId: r.value.decisionId, path: r.value.path });
  }
  return outcome(res.failed.length > 0 ? EXIT.ERROR : EXIT.OK, summary(L, res));
}

function summary(L: Locale, res: SessionResult): string[] {
  const done = new Set(res.confirmed.map((c) => c.proposalId));
  const pending = res.reviewed.filter((id) => !done.has(id));
  return [
    ...res.confirmed.map((c) => t(L, "decision.session.confirmed-item", { from: c.proposalId, id: c.decisionId, path: c.path })),
    t(L, "decision.session.summary", { done: res.confirmed.length, selected: res.selected.length, pending: pending.length === 0 ? t(L, "decision.preview.none") : pending.join(", ") }),
    ...(res.confirmed.length > 0 ? [t(L, "decision.index-hint")] : []),
  ];
}
