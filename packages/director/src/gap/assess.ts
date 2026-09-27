/**
 * Knowledge Gap assessment (TASK-011): which undecided things matter for this task? Separate from
 * the Context Compiler, which chooses what to show; this reads its result (status, resolution,
 * Packet signals, pending decisions, items) plus Project Truth and decides, deterministically and
 * without an LLM, what to ask, what to surface and what to ignore.
 *
 * Policy:
 * - index-required: no judgement at all (a stale graph must not produce questions).
 * - ambiguous target, unresolved explicit ID: ask.
 * - pending decision the task depends on (requiresHumanDecision): ask; other related pending: surface.
 * - no seed, no confirmed intent: surface (a bug fix may not need intent; nothing proves otherwise).
 * - declared gap: resolved by an active Decision → ignore; else direct → ask, related → surface,
 *   none → ignore (shared relevance policy).
 * - technical uncertainty (unresolved calls, partial parses) is never a gap: it stays a limitation.
 * Priority of asks: ambiguous-target, unresolved-target, pending-decision, declared.
 */
import { createHash } from "node:crypto";
import {
  compareUtf8, definitionRef, parseNodeId, PROJECT_REF, type Decision, type DeclaredGap, type EntityRef, type ProjectTruth,
} from "@duo-director/core";
import type { ContextPacket, ContextRequest, ContextResult } from "../context/types.js";
import { matchDeclaredGap, type RelevanceScope, type ScopeEntry } from "../relevance/index.js";
import type { GapAction, GapKind, GapRelevance, KnowledgeGap, KnowledgeGapAssessment } from "./types.js";

export interface AssessInput {
  readonly request: ContextRequest;
  readonly result: ContextResult;
  readonly truth: ProjectTruth;
}

const ASK_PRIORITY: Readonly<Record<GapKind, number>> = {
  "ambiguous-target": 0, "unresolved-target": 1, "pending-decision": 2, declared: 3, "missing-intent": 4,
};
const ACTION_ORDER: Readonly<Record<GapAction, number>> = { ask: 0, surface: 1, ignore: 2 };
const INTENT_LIMITATIONS: ReadonlySet<string> = new Set(["no-confirmed-intent"]);

function runtimeId(kind: GapKind, task: string, anchors: readonly string[]): string {
  const input = `${kind}\n${task}\n${[...anchors].sort(compareUtf8).join("\n")}`;
  return `rgap-${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
}

function refOfDefinition(truth: ProjectTruth, id: string): EntityRef | undefined {
  if (truth.requirements.some((r) => r.id === id)) return definitionRef("requirement", id);
  if (truth.decisions.some((d) => d.id === id) || truth.constraints.some((c) => c.id === id)) return definitionRef("decision", id);
  if (truth.issues.some((i) => i.id === id)) return definitionRef("issue", id);
  if (truth.milestones.some((m) => m.id === id)) return definitionRef("milestone", id);
  return undefined;
}

/** The Packet as a relevance scope: included items in rank order, then candidates omitted by budget. */
export function packetScope(packet: ContextPacket, task: string): RelevanceScope {
  const seeds = new Set(packet.seeds.map((s) => s.id));
  const items = [...packet.intent.requirements, ...packet.intent.constraints, ...packet.decisions.active, ...packet.code, ...packet.tests, ...packet.issues]
    .sort((a, b) => a.rank - b.rank);
  const entries: ScopeEntry[] = [];
  for (const i of items) {
    const ref = parseNodeId(i.id);
    if (ref === undefined) continue;
    entries.push({ id: i.id, ref: i.ref, type: ref.type, hops: i.via.steps.length, seed: seeds.has(i.id), ...(i.source === undefined ? {} : { path: i.source.path }) });
  }
  for (const o of packet.omittedCandidates) {
    const ref = parseNodeId(o.id);
    if (ref !== undefined) entries.push({ id: o.id, ref: o.ref, type: ref.type, hops: undefined, seed: seeds.has(o.id) });
  }
  return { entries, taskText: task };
}

function active(d: Decision): boolean {
  return d.state === "confirmed" && d.supersededBy === null;
}

/** Does Decision d speak for the gap's owner? (resolution rule; see 03 Knowledge Gap) */
function covers(d: Decision, gap: DeclaredGap, truth: ProjectTruth): boolean {
  const owner = gap.owner;
  if (owner.type === "project") return true;
  switch (owner.type) {
    case "requirement": return d.governs.requirements.includes(owner.id);
    case "issue": {
      const issue = truth.issues.find((i) => i.id === owner.id);
      return issue !== undefined && (issue.decisions.includes(d.id) || issue.requirements.some((r) => d.governs.requirements.includes(r)));
    }
    case "milestone":
      return truth.requirements.some((r) => r.milestone === owner.id && d.governs.requirements.includes(r.id));
    case "decision": {
      if (d.id === owner.id) return true;
      const target = truth.decisions.find((x) => x.id === owner.id);
      let cur: string | null = d.supersedes;
      for (let n = 0; cur !== null && n < 16; n++) {
        if (cur === owner.id) return true;
        cur = truth.decisions.find((x) => x.id === cur)?.supersedes ?? null;
      }
      return target !== undefined && target.governs.requirements.some((r) => d.governs.requirements.includes(r));
    }
  }
}

/**
 * Minimal explicit resolution: a declared gap with a key ("UNKNOWN(key): …") is resolved by an
 * active confirmed Decision whose question is that key and that covers the owner. No key or no
 * such Decision: unresolved. Text is never interpreted.
 */
export function resolvingDecision(gap: DeclaredGap, truth: ProjectTruth): string | undefined {
  if (gap.key === undefined) return undefined;
  return truth.decisions.filter((d) => active(d) && d.question === gap.key && covers(d, gap, truth)).map((d) => d.id).sort(compareUtf8)[0];
}

const EMPTY_METRICS = { declaredConsidered: 0, runtime: 0, direct: 0, related: 0, none: 0, ask: 0, surface: 0, ignore: 0, llmCalls: 0 as const };

export function assessKnowledgeGaps(input: AssessInput): KnowledgeGapAssessment {
  const { result, truth } = input;
  const task = input.request.task.trim();
  if (result.status === "index-required") {
    return { format: "duo.gap-assessment/1", status: "index-required", gaps: [], requiresHumanInput: false, additional: [], technicalLimitations: [], metrics: EMPTY_METRICS };
  }
  const gaps: (KnowledgeGap & { order: number })[] = [];
  const resolution = result.resolution;

  (resolution?.ambiguities ?? []).forEach((a, n) => {
    const anchors = a.options.flatMap((o) => parseNodeId(o.id) ?? []);
    gaps.push({
      id: runtimeId("ambiguous-target", task, a.options.map((o) => o.id)), source: "runtime", kind: "ambiguous-target",
      text: `"${a.term}" matches ${a.options.length} candidates`, anchors, relevance: "direct",
      reasons: [{ code: "ambiguous-seed", ref: a.term, detail: a.reason }], action: "ask", term: a.term, options: a.options, order: n,
    });
  });
  (resolution?.unresolvedIds ?? []).forEach((id, n) => {
    gaps.push({
      id: runtimeId("unresolved-target", task, [id]), source: "runtime", kind: "unresolved-target", text: `${id} is not in Project Truth`, anchors: [],
      relevance: "direct", reasons: [{ code: "unresolved-id", ref: id }], action: "ask", target: id, order: n,
    });
  });
  if (result.status === "insufficient-context" && (resolution?.unresolvedIds.length ?? 0) === 0) {
    gaps.push({
      id: runtimeId("missing-intent", task, []), source: "runtime", kind: "missing-intent", text: "no Requirement, Decision or code matches the task",
      anchors: [], relevance: "direct", reasons: [{ code: "no-seed" }], action: "surface", order: 0,
    });
  }

  const packet = result.status === "ready" ? result.packet : undefined;
  if (packet !== undefined) {
    if (packet.signals.some((s) => s.kind === "no-confirmed-intent")) {
      const anchors = packet.seeds.flatMap((s) => parseNodeId(s.id) ?? []);
      gaps.push({
        id: runtimeId("missing-intent", task, packet.seeds.map((s) => s.id)), source: "runtime", kind: "missing-intent",
        text: "no confirmed Requirement, Decision or Constraint relates to this task", anchors, relevance: "direct",
        reasons: [{ code: "no-confirmed-intent" }], action: "surface", order: 0,
      });
    }
    packet.pendingDecisions.forEach((p, n) => {
      const anchors = p.relatesTo.flatMap((id) => refOfDefinition(truth, id) ?? []);
      const requires = p.requiresHumanDecision;
      gaps.push({
        id: runtimeId("pending-decision", task, [p.id, ...p.relatesTo]), source: "runtime", kind: "pending-decision",
        text: `${p.id} ${p.title} is PENDING / NOT CONFIRMED`, anchors, relevance: requires ? "direct" : "related",
        reasons: [{ code: requires ? "requires-human-decision" : "pending-related", ref: p.id, ...(p.relatesTo.length === 0 ? {} : { detail: p.relatesTo.join(", ") }) }],
        action: requires ? "ask" : "surface", pending: { id: p.id, title: p.title, relatesTo: p.relatesTo }, order: n,
      });
    });
  }

  const scope: RelevanceScope = packet === undefined ? { entries: [], taskText: task } : packetScope(packet, task);
  const rank = new Map<string, number>(scope.entries.map((e, i) => [`${e.type}:${e.ref}`, i]));
  for (const g of truth.gaps) {
    const r = matchDeclaredGap(g, scope, truth);
    const decision = resolvingDecision(g, truth);
    const action: GapAction = decision !== undefined ? "ignore" : r.relevance === "direct" ? "ask" : r.relevance === "related" ? "surface" : "ignore";
    const ownerKey = g.owner.type === "project" ? "project:" : `${g.owner.type}:${g.owner.id}`;
    gaps.push({
      id: g.id, source: "declared", kind: "declared", text: g.text, anchors: [g.owner.type === "project" ? PROJECT_REF : g.owner], location: g.location,
      relevance: r.relevance, action, ...(g.key === undefined ? {} : { key: g.key }),
      reasons: [...r.reasons, decision === undefined ? { code: "no-resolution" as const } : { code: "resolved-by-decision" as const, ref: decision, ...(g.key === undefined ? {} : { detail: g.key }) }],
      resolution: decision === undefined ? { status: "unresolved" } : { status: "resolved", decision },
      order: rank.get(ownerKey) ?? Number.MAX_SAFE_INTEGER,
    });
  }

  gaps.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || ASK_PRIORITY[a.kind] - ASK_PRIORITY[b.kind] || a.order - b.order || compareUtf8(a.id, b.id));
  const out: KnowledgeGap[] = gaps.map((g) => {
    const copy: Partial<typeof g> = { ...g };
    delete copy.order;
    return copy as KnowledgeGap;
  });
  const asks = out.filter((g) => g.action === "ask").map((g) => g.id);
  const count = (pred: (g: KnowledgeGap) => boolean) => out.filter(pred).length;
  const rel = (x: GapRelevance) => count((g) => g.relevance === x);
  return {
    format: "duo.gap-assessment/1",
    status: "assessed",
    gaps: out,
    requiresHumanInput: asks.length > 0,
    ...(asks[0] === undefined ? {} : { primary: asks[0] }),
    additional: asks.slice(1),
    // Intent limitations are gaps above; what stays here is DUO's own analysis limits.
    technicalLimitations: packet?.limitations.map((l) => l.code).filter((c) => !INTENT_LIMITATIONS.has(c)) ?? [],
    metrics: {
      declaredConsidered: truth.gaps.length, runtime: count((g) => g.source === "runtime"),
      direct: rel("direct"), related: rel("related"), none: rel("none"),
      ask: asks.length, surface: count((g) => g.action === "surface"), ignore: count((g) => g.action === "ignore"), llmCalls: 0,
    },
  };
}
