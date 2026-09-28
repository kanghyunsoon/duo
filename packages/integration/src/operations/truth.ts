/** duo_get_requirement / duo_get_decision: one Project Truth definition, its exact source slice and metadata. */
import { readSourceSlice, type SourceRef } from "@duo-director/core";
import { guarded, project, type Operation, type Failure } from "./common.js";

export const REQUIREMENT_FORMAT = "duo.requirement/1";
export const DECISION_FORMAT = "duo.decision/1";

const sources = (s: readonly SourceRef[]) => s.map((x) => (x.kind === "label" ? { label: x.label } : { path: x.path, hash: x.hash, ...(x.section === undefined ? {} : { section: x.section }) }));

export function getRequirement(root: string, id: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const r = p.value.truth.requirements.find((x) => x.id === id);
    if (r === undefined) return { kind: "ok", diagnostics: [], payload: { format: REQUIREMENT_FORMAT, status: "not-found", id } };
    const text = readSourceSlice(root, r.location).value;
    return {
      kind: "ok", diagnostics: [], payload: {
        format: REQUIREMENT_FORMAT, status: "found", id,
        requirement: {
          id: r.id, title: r.title, status: r.status, milestone: r.milestone, priority: r.priority ?? null, sources: sources(r.sources),
          implements: r.implements, tests: r.tests, dependsOn: r.dependsOn, location: r.location,
        },
        ...(text === undefined ? {} : { text }),
      },
    };
  });
}

export function getDecision(root: string, id: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const { truth } = p.value;
    const d = truth.decisions.find((x) => x.id === id);
    const c = truth.constraints.find((x) => x.id === id);
    if (d === undefined && c === undefined) {
      const proposal = truth.proposals.some((x) => x.id === id);
      return { kind: "ok", diagnostics: [], payload: { format: DECISION_FORMAT, status: "not-found", id, ...(proposal ? { note: "This ID is a proposal, not a Decision: it is not confirmed intent." } : {}) } };
    }
    const location = (d ?? c)?.location;
    const text = location === undefined ? undefined : readSourceSlice(root, location).value;
    const decision = d !== undefined ? {
      kind: "decision", id: d.id, title: d.title, state: d.state, active: d.state === "confirmed" && d.supersededBy === null, supersedes: d.supersedes, supersededBy: d.supersededBy,
      question: d.question, answer: d.answer, rationale: d.rationale ?? null, enforcement: d.enforcement ?? null, governs: d.governs, forbids: d.forbids,
      sources: sources(d.sources), lock: d.lock ?? null, confirmedBy: d.confirmedBy ?? null, confirmedAt: d.confirmedAt ?? null, location: d.location,
    } : c === undefined ? undefined : {
      kind: "constraint", id: c.id, statement: c.statement, state: c.state, active: c.state === "confirmed", enforcement: c.enforcement, match: c.match,
      sources: sources(c.sources), location: c.location,
    };
    return { kind: "ok", diagnostics: [], payload: { format: DECISION_FORMAT, status: "found", id, decision, ...(text === undefined ? {} : { text }) } };
  });
}
