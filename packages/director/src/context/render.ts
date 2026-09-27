/**
 * Markdown rendering of a Context Packet (TASK-010). Formatting only: the Compiler selects, this
 * module prints what the Packet holds, in a fixed section order (stable items first, which helps
 * agent-side prompt caching). The Packet budget is measured on this text, so the packer uses the
 * same item and evidence renderers.
 */
import { TOKEN_ESTIMATOR } from "../tokens/index.js";
import type { ContextPacket, EvidenceStep, PacketItem, PendingDecisionItem } from "./types.js";

export function renderItemBlock(text: string): string {
  return `- ${text}`;
}

export function renderVia(via: PacketItem["via"]): string {
  if (via.steps.length === 0) return `seed ${via.seed}`;
  return via.steps.map((s: EvidenceStep) => `${s.from} -${s.type}-> ${s.to} [${s.provenance}]`).join(", ");
}

/** "src/a.ts#A.b" → "A.b"; IDs and paths stay as they are. */
export function shortRef(ref: string): string {
  const hash = ref.indexOf("#");
  return hash < 0 ? ref : ref.slice(hash + 1);
}

/** One line per item: the last edge that brought it in (the full path is in the JSON evidence). */
export function renderEvidenceLine(ref: string, via: PacketItem["via"]): string {
  const last = via.steps[via.steps.length - 1];
  if (last === undefined) return `- ${shortRef(ref)}: seed`;
  const hops = via.steps.length > 1 ? ` (${via.steps.length} hops from ${shortRef(via.seed)})` : "";
  return `- ${shortRef(ref)}: ${shortRef(last.from)} ${last.type} ${shortRef(last.to)} [${last.provenance}]${hops}`;
}

function list(items: readonly { readonly text: string }[]): string[] {
  return items.length === 0 ? ["(none)"] : items.map((i) => renderItemBlock(i.text));
}

export const PENDING_NOTICE = "Not confirmed. These are open questions for a human, not instructions; do not implement them as decided.";
export const SCOPE_NOTICE = "Task-scoped subset of the project graph. It is not the whole project context.";

export function renderContextMarkdown(packet: ContextPacket): string {
  const out: string[] = [];
  out.push("# DUO CONTEXT PACKET");
  out.push(`budget ${packet.request.budget} tokens (${TOKEN_ESTIMATOR.name}) · profile ${packet.request.profile} · llm_calls 0`);
  out.push(SCOPE_NOTICE, "");
  out.push("## TASK", packet.request.task + (packet.request.taskTruncated ? " …(truncated)" : ""));
  out.push(`seeds: ${packet.seeds.length === 0 ? "none" : packet.seeds.map((s) => `${s.ref} (${s.match})`).join(", ")}`, "");
  out.push("## CONFIRMED INTENT", "### Requirements", ...list(packet.intent.requirements));
  out.push("### Constraints", ...list(packet.intent.constraints));
  out.push("### Active Decisions", ...list(packet.decisions.active));
  if (packet.decisions.history.length > 0) {
    out.push("### Decision History (superseded, not active)");
    for (const h of packet.decisions.history) out.push(`- ${h.id} ${h.title} — superseded${h.supersededBy === null ? "" : ` by ${h.supersededBy}`}`);
  }
  out.push("", "## RELEVANT CODE", ...list(packet.code));
  out.push("", "## TESTS", ...list(packet.tests));
  out.push("", "## ISSUES / MILESTONE", ...list(packet.issues));
  out.push("", "## PENDING HUMAN DECISIONS");
  if (packet.pendingDecisions.length === 0) out.push("(none)");
  else out.push(PENDING_NOTICE, ...packet.pendingDecisions.map((p: PendingDecisionItem) => renderItemBlock(p.text)));
  out.push("", "## EVIDENCE");
  if (packet.evidence.length === 0) out.push("(none)");
  else out.push(...packet.evidence.map((e) => renderEvidenceLine(e.ref, e.via)));
  out.push("", "## LIMITATIONS", ...packet.limitations.map((l) => `- ${l.message}`));
  return out.join("\n") + "\n";
}
