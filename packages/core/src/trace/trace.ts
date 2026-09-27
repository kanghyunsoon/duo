/**
 * Traceability over definitions: global ID uniqueness, reference resolution, and the
 * links (GOVERNS, TRACKED_BY, REQUIRES, SUPERSEDES) that the Project Graph will store in TASK-007.
 */
import { createDiagnostic, formatLocation, withSeverity, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import type { DefinitionRef, DefinitionType } from "../ids.js";
import type { DeclaredReference, Definition, DefinitionSet, TraceRelation } from "../domain/model.js";

export interface TraceLink {
  readonly relation: TraceRelation;
  readonly from: DefinitionRef;
  readonly to: DefinitionRef;
  readonly declaredAt: SourceLocation;
}

export interface TraceEntity {
  readonly ref: DefinitionRef;
  readonly location: SourceLocation;
}

export interface TraceModel {
  /** Definition ID → entity. IDs are global across types. */
  readonly entities: ReadonlyMap<string, TraceEntity>;
  /** Acceptance criterion ID → owning issue ID. */
  readonly acceptance: ReadonlyMap<string, string>;
  readonly links: readonly TraceLink[];
}

export interface TracePolicy {
  /** Report requirements (not deferred) without a tracking issue as errors instead of info. */
  readonly requireTrackedRequirements?: boolean;
}

export interface TraceInput extends DefinitionSet {
  /** Extra references, e.g. project.yaml current_milestone. */
  readonly references?: readonly DeclaredReference[];
}

const ENTITY_TYPE: Record<Definition["kind"], DefinitionType> = {
  requirement: "requirement",
  decision: "decision",
  constraint: "decision",
  issue: "issue",
  milestone: "milestone",
};

export function analyzeTrace(input: TraceInput, policy: TracePolicy = {}): { model: TraceModel; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const entities = new Map<string, TraceEntity>();
  const definitions: Definition[] = [...input.requirements, ...input.decisions, ...input.constraints, ...input.issues, ...input.milestones];

  for (const def of definitions) {
    const existing = entities.get(def.id);
    if (existing !== undefined) {
      diagnostics.push(createDiagnostic("DUPLICATE_ID", `ID "${def.id}" is already defined at ${formatLocation(existing.location)}`, def.location));
      continue;
    }
    entities.set(def.id, { ref: { type: ENTITY_TYPE[def.kind], id: def.id }, location: def.location });
  }

  const acceptance = new Map<string, string>();
  const acceptanceAt = new Map<string, SourceLocation>();
  for (const issue of input.issues) {
    for (const ac of issue.acceptance) {
      const first = acceptanceAt.get(ac.id);
      if (first !== undefined || entities.has(ac.id)) {
        const at = first ?? entities.get(ac.id)?.location;
        diagnostics.push(createDiagnostic("DUPLICATE_ID", `ID "${ac.id}" is already defined${at ? ` at ${formatLocation(at)}` : ""}`, ac.location));
        continue;
      }
      acceptance.set(ac.id, issue.id);
      acceptanceAt.set(ac.id, ac.location);
    }
  }

  const links: TraceLink[] = [];
  const check = (owner: DefinitionRef | undefined, refs: readonly DeclaredReference[]): void => {
    for (const r of refs) {
      const target = entities.get(r.target);
      if (target === undefined) {
        diagnostics.push(createDiagnostic("BROKEN_REFERENCE", `${r.field} references "${r.target}", which is not defined`, r.location));
      } else if (target.ref.type !== r.expected) {
        diagnostics.push(createDiagnostic(
          "REFERENCE_TYPE_MISMATCH",
          `${r.field} expects a ${r.expected}, but "${r.target}" is a ${target.ref.type}`,
          r.location,
        ));
      } else if (r.relation !== undefined && owner !== undefined) {
        const outgoing = r.relation.direction === "outgoing";
        links.push({ relation: r.relation.type, from: outgoing ? owner : target.ref, to: outgoing ? target.ref : owner, declaredAt: r.location });
      }
    }
  };
  for (const def of definitions) check({ type: ENTITY_TYPE[def.kind], id: def.id }, def.references);
  for (const proposal of input.proposals) check(undefined, proposal.references);
  check(undefined, input.references ?? []);

  // SUPERSEDES: no self-supersede, no cycles (direct or multi-hop). New decision → old decision.
  const supersedes = links.filter((l) => l.relation === "SUPERSEDES");
  for (const link of supersedes) {
    if (link.from.id === link.to.id) {
      diagnostics.push(createDiagnostic("DECISION_SUPERSEDES_SELF", `${link.from.id} supersedes itself`, link.declaredAt));
    }
  }
  const next = new Map<string, TraceLink[]>();
  for (const link of supersedes) if (link.from.id !== link.to.id) next.set(link.from.id, [...(next.get(link.from.id) ?? []), link]);
  const reported = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const stack: TraceLink[] = [];
  const visit = (id: string): void => {
    state.set(id, "visiting");
    for (const link of next.get(id) ?? []) {
      const target = link.to.id;
      if (state.get(target) === "visiting") {
        const start = stack.findIndex((l) => l.from.id === target);
        const cycle = [...stack.slice(start === -1 ? stack.length : start), link];
        const ids = cycle.map((l) => l.from.id);
        const key = [...ids].sort().join(" ");
        if (!reported.has(key)) {
          reported.add(key);
          const first = [...cycle].sort((a, b) => a.from.id.localeCompare(b.from.id))[0] ?? link;
          diagnostics.push(createDiagnostic(
            "DECISION_SUPERSEDE_CYCLE",
            `Supersede cycle: ${[...ids, target].join(" → ")}`,
            first.declaredAt,
          ));
        }
      } else if (state.get(target) === undefined) {
        stack.push(link);
        visit(target);
        stack.pop();
      }
    }
    state.set(id, "done");
  };
  for (const id of [...next.keys()].sort()) if (state.get(id) === undefined) visit(id);
  const validLinks = links.filter((l) => !(l.relation === "SUPERSEDES" && l.from.id === l.to.id));
  links.length = 0;
  links.push(...validLinks);

  // Milestone membership: a milestone lists issue IDs; an issue may also name its milestone.
  const issuesById = new Map(input.issues.map((i) => [i.id, i]));
  const listedBy = new Map<string, string>();
  for (const milestone of input.milestones) {
    for (const ref of milestone.references) {
      if (ref.field !== "issues") continue;
      const issue = issuesById.get(ref.target);
      const previous = listedBy.get(ref.target);
      if (previous !== undefined && previous !== milestone.id) {
        diagnostics.push(createDiagnostic("TRACE_MILESTONE_MISMATCH", `${ref.target} is listed by both ${previous} and ${milestone.id}`, ref.location));
      } else if (issue?.milestone && issue.milestone !== milestone.id) {
        diagnostics.push(createDiagnostic(
          "TRACE_MILESTONE_MISMATCH",
          `${milestone.id} lists ${ref.target}, but ${ref.target} declares milestone ${issue.milestone}`,
          ref.location,
        ));
      }
      listedBy.set(ref.target, milestone.id);
    }
  }

  const decisions = new Map(input.decisions.map((d) => [d.id, d]));
  for (const issue of input.issues) {
    for (const ref of issue.references) {
      if (ref.field !== "decisions") continue;
      const decision = decisions.get(ref.target);
      if (decision !== undefined && !decision.governs.requirements.some((r) => issue.requirements.includes(r))) {
        diagnostics.push(createDiagnostic(
          "TRACE_DECISION_UNRELATED",
          `${issue.id} lists ${decision.id}, but ${decision.id} governs none of ${issue.id}'s requirements`,
          ref.location,
        ));
      }
    }
  }

  const tracked = new Set(links.filter((l) => l.relation === "TRACKED_BY").map((l) => l.from.id));
  for (const req of input.requirements) {
    if (req.status === "deferred" || tracked.has(req.id)) continue;
    if (entities.get(req.id)?.location !== req.location) continue; // duplicate definition, already reported
    const d = createDiagnostic("TRACE_REQUIREMENT_UNTRACKED", `${req.id} is not tracked by any issue`, req.location);
    diagnostics.push(policy.requireTrackedRequirements ? withSeverity(d, "error") : d);
  }

  links.sort((a, b) => (a.relation + a.from.id + "\u0000" + a.to.id).localeCompare(b.relation + b.from.id + "\u0000" + b.to.id));
  return { model: { entities, acceptance, links }, diagnostics };
}
