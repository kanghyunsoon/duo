/**
 * UI read models (T18.1). Projections that combine existing Domain reads for one screen: they add no
 * Truth, no score and no state. Status, graph, context and review come from the shared operations
 * (operations/), proposals from listDecisionProposals(), history from listReviewRecords().
 */
import {
  createDecisionService, definitionRef, listDecisionProposals, nodeId, readSourceSlice, type Decision, type ProjectTruth, type SourceLocation,
} from "@duo-director/core";
import { listReviewRecords } from "@duo-director/director";
import { projectGraphQuery } from "../operations/graph.js";
import { guarded, project, type Failure, type Operation, type OperationOptions } from "../operations/common.js";
import { projectStatus } from "../operations/status.js";

const loc = (l: SourceLocation) => ({ path: l.path, ...(l.startLine === undefined ? {} : { startLine: l.startLine }), ...(l.endLine === undefined ? {} : { endLine: l.endLine }) });

/** CONFIRMED, PROPOSED, SUPERSEDED, REJECTED: how a Decision is shown (never a proposal shown as a Decision). */
export function decisionLabel(d: Decision): "CONFIRMED" | "PROPOSED" | "SUPERSEDED" | "REJECTED" {
  if (d.state === "confirmed" && d.supersededBy === null) return "CONFIRMED";
  if (d.state === "superseded" || (d.state === "confirmed" && d.supersededBy !== null)) return "SUPERSEDED";
  return d.state === "rejected" ? "REJECTED" : "PROPOSED";
}

/** Overview: the status operation's payload, Truth counts and the latest recorded Review verdict. */
export function projectOverview(root: string, options: OperationOptions = {}): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const { truth } = p.value;
    const status = await projectStatus(root, options);
    if (status.kind !== "ok") return status;
    const records = await listReviewRecords(root);
    const latest = records.value?.[0];
    const review = latest?.body.review as { verdict?: string } | undefined;
    const statusCounts = (items: readonly { status: string }[]) => Object.fromEntries([...new Set(items.map((i) => i.status))].sort().map((s) => [s, items.filter((i) => i.status === s).length]));
    return {
      kind: "ok", diagnostics: status.diagnostics,
      payload: {
        status: status.payload,
        currentMilestone: truth.config.currentMilestone === null ? null : truth.milestones.find((m) => m.id === truth.config.currentMilestone)
          ? { id: truth.config.currentMilestone, title: truth.milestones.find((m) => m.id === truth.config.currentMilestone)?.title ?? "" } : { id: truth.config.currentMilestone, title: "" },
        requirements: { total: truth.requirements.length, byStatus: statusCounts(truth.requirements) },
        decisions: { active: truth.decisions.filter((d) => decisionLabel(d) === "CONFIRMED").length, total: truth.decisions.length },
        declaredGaps: truth.gaps.map((g) => ({ id: g.id, owner: nodeId(g.owner), ...(g.key === undefined ? {} : { key: g.key }), text: g.text, location: loc(g.location) })),
        latestReview: latest === undefined ? null : { id: latest.id, verdict: review?.verdict ?? null, recordedAt: latest.recorded?.at ?? null },
      },
    };
  });
}

function directionOf(truth: ProjectTruth) {
  const proposals = listDecisionProposals(truth);
  return {
    vision: truth.vision === undefined || truth.vision === null ? null : { status: truth.vision.status, body: truth.vision.body, location: loc(truth.vision.location) },
    milestones: truth.milestones.map((m) => ({ id: m.id, title: m.title, state: m.state, current: m.id === truth.config.currentMilestone, issues: m.issues, location: loc(m.location) })),
    requirements: truth.requirements.map((r) => ({
      id: r.id, title: r.title, status: r.status, milestone: r.milestone, priority: r.priority ?? null, implements: r.implements, tests: r.tests, location: loc(r.location),
    })),
    constraints: truth.constraints.map((c) => ({ id: c.id, statement: c.statement, state: c.state, enforcement: c.enforcement, location: loc(c.location) })),
    decisions: truth.decisions.map((d) => ({
      id: d.id, title: d.title, label: decisionLabel(d), state: d.state, question: d.question, answer: d.answer, enforcement: d.enforcement ?? null,
      governs: d.governs, supersedes: d.supersedes, supersededBy: d.supersededBy, locked: d.lock !== undefined, location: loc(d.location),
    })),
    proposals: proposals.map((e) => ({
      id: e.id, status: e.status, title: e.proposal.title, question: e.proposal.question, answer: e.proposal.answer, rationale: e.proposal.rationale ?? null,
      supersedes: e.proposal.supersedes, governs: e.proposal.governs, proposedBy: e.proposal.proposedBy, proposedAt: e.proposal.proposedAt ?? null,
      ...(e.decisionId === undefined ? {} : { decisionId: e.decisionId }), ...(e.proposal.reason === undefined ? {} : { reason: e.proposal.reason }),
      location: loc(e.proposal.location),
    })),
    issues: truth.issues.map((i) => ({ id: i.id, title: i.title, status: i.status, milestone: i.milestone, location: loc(i.location) })),
  };
}

/** Direction: Vision, Milestones, Requirements, Constraints, Decisions (labelled), proposals by read-model status. */
export function projectDirection(root: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    return { kind: "ok", diagnostics: [], payload: directionOf(p.value.truth) };
  });
}

/** Pending proposals with what confirming each would do (DecisionService.previewConfirm, read-only). */
export function projectProposals(root: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const d = directionOf(p.value.truth);
    const service = createDecisionService({ root });
    const previews: Record<string, unknown> = {};
    for (const e of d.proposals.filter((x) => x.status === "pending")) {
      const preview = await service.previewConfirm(e.id);
      previews[e.id] = preview.value ?? { error: preview.diagnostics.map((x) => x.code) };
    }
    return { kind: "ok", diagnostics: [], payload: { proposals: d.proposals, previews } };
  });
}

/**
 * One entity: a Truth definition (exact source slice) or a graph node (by ID, path or unique symbol
 * name), with its direct relations from the trace primitive (depth 1).
 */
export function projectEntity(root: string, id: string, options: OperationOptions = {}): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const { truth } = p.value;
    const direction = directionOf(truth);
    const sources = new Map<string, SourceLocation>([
      ...truth.requirements, ...truth.decisions, ...truth.constraints, ...truth.milestones, ...truth.issues, ...truth.proposals,
    ].map((x) => [x.id, x.location] as const));
    const all = [
      ...direction.requirements.map((x) => ({ type: "requirement", item: x })), ...direction.decisions.map((x) => ({ type: "decision", item: x })),
      ...direction.constraints.map((x) => ({ type: "constraint", item: x })), ...direction.milestones.map((x) => ({ type: "milestone", item: x })),
      ...direction.issues.map((x) => ({ type: "issue", item: x })), ...direction.proposals.map((x) => ({ type: "proposal", item: x })),
    ];
    const definition = all.find((x) => x.item.id === id);
    const source = sources.get(id);
    const text = definition === undefined || source === undefined ? undefined : readSourceSlice(root, source).value;
    // A Constraint is a Decision-type graph entity (C14); a proposal is not in the graph.
    const graphType = definition?.type === "constraint" ? "decision" : definition?.type;
    const node = definition === undefined ? id : graphType === "proposal" ? undefined : nodeId(definitionRef(graphType as "requirement", id));
    const trace = node === undefined ? undefined : await projectGraphQuery(root, "trace", node, 1, options);
    const traced = trace?.kind === "ok" ? trace.payload : undefined;
    if (definition === undefined && (traced === undefined || traced.status === "not-found")) return { kind: "ok", diagnostics: [], payload: { status: "not-found", id } };
    return {
      kind: "ok", diagnostics: [],
      payload: {
        status: "found", id, ...(definition === undefined ? { type: "node" } : { type: definition.type, definition: definition.item }),
        ...(text === undefined ? {} : { text }), ...(traced === undefined ? {} : { trace: traced }),
      },
    };
  });
}

/** Human-recorded Review Records (and their separate semantic supplements), newest first. */
export function projectReviewHistory(root: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const r = await listReviewRecords(root);
    return {
      kind: "ok", diagnostics: [],
      payload: { records: r.value ?? [], problems: r.diagnostics.map((d) => ({ code: d.code, message: d.message, ...(d.source?.path === undefined ? {} : { path: d.source.path }) })) },
    };
  });
}
