/**
 * The informed-confirm preview of one candidate as lines (T34.2), shared by duoctl decision confirm/reject and the
 * review-pending session (T44).
 */
import type { ConfirmPreview } from "@duo-director/core";
import { t, type Locale } from "../messages.js";

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
