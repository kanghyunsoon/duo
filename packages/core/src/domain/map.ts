/**
 * Validated file data (snake_case) → domain objects (camelCase). Normalizes paths and records
 * every reference with its source location.
 */
import { createDiagnostic, withSource, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import type { DefinitionType } from "../ids.js";
import { normalizeRepoPath, normalizeRepoPattern } from "../paths.js";
import type {
  ConstraintData, DecisionData, EvidencePointerData, IssueBlockData,
  ProjectConfigData, ProposalData, RequirementBlockData, SourceRefData, VisionFrontmatterData,
} from "../schema/schemas.js";
import type { DataPath, ParsedYaml } from "../source/yaml.js";
import type {
  Constraint, DeclaredReference, Decision, DecisionContent, EvidencePointer, Issue, AcceptanceCriterion,
  Milestone, MilestoneState, ProjectConfig, Proposal, Requirement, SourceRef, TraceRelation, Vision,
} from "./model.js";

export class MapContext {
  readonly references: DeclaredReference[] = [];
  constructor(
    readonly yaml: ParsedYaml,
    readonly fallback: SourceLocation,
    readonly diagnostics: Diagnostic[],
    readonly base: DataPath = [],
  ) {}

  at(path: DataPath): SourceLocation {
    return this.yaml.locate([...this.base, ...path]) ?? this.fallback;
  }

  child(base: DataPath): MapContext {
    return new MapContext(this.yaml, this.at(base), this.diagnostics, [...this.base, ...base]);
  }

  ref(field: string, path: DataPath, target: string, expected: DefinitionType, relation?: { type: TraceRelation; direction: "outgoing" | "incoming" }): void {
    this.references.push({ field, target, expected, relation, location: this.at(path) });
  }

  refs(field: string, path: DataPath, targets: readonly string[] | undefined, expected: DefinitionType, relation?: { type: TraceRelation; direction: "outgoing" | "incoming" }): readonly string[] {
    const list = targets ?? [];
    list.forEach((t, i) => this.ref(field, [...path, i], t, expected, relation));
    return list;
  }

  patterns(path: DataPath, values: readonly string[] | undefined): string[] {
    const out: string[] = [];
    (values ?? []).forEach((v, i) => {
      const r = normalizeRepoPattern(v);
      if (r.value !== undefined) out.push(r.value);
      for (const d of r.diagnostics) this.diagnostics.push(withSource(d, this.at([...path, i])));
    });
    return out;
  }

  sources(path: DataPath, values: readonly SourceRefData[] | undefined): SourceRef[] {
    const out: SourceRef[] = [];
    (values ?? []).forEach((v, i) => {
      if (typeof v === "string") {
        out.push({ kind: "label", label: v });
        return;
      }
      const r = normalizeRepoPath(v.path);
      for (const d of r.diagnostics) this.diagnostics.push(withSource(d, this.at([...path, i, "path"])));
      if (r.value !== undefined) out.push({ kind: "external", path: r.value, hash: v.hash, section: v.section });
    });
    return out;
  }

  evidence(path: DataPath, values: readonly EvidencePointerData[] | undefined): EvidencePointer[] {
    const out: EvidencePointer[] = [];
    (values ?? []).forEach((v, i) => {
      let repoPath: EvidencePointer["path"];
      if (v.path !== undefined) {
        const r = normalizeRepoPath(v.path);
        for (const d of r.diagnostics) this.diagnostics.push(withSource(d, this.at([...path, i, "path"])));
        repoPath = r.value;
      }
      out.push({
        kind: v.kind, id: v.id, path: repoPath, symbol: v.symbol, lines: v.lines,
        commit: v.commit, contentHash: v.content_hash, change: v.change,
      });
    });
    return out;
  }
}

export function mapProjectConfig(d: ProjectConfigData, ctx: MapContext): ProjectConfig {
  if (d.current_milestone) ctx.ref("current_milestone", ["current_milestone"], d.current_milestone, "milestone");
  return {
    schemaVersion: d.schema_version,
    name: d.name,
    currentMilestone: d.current_milestone ?? null,
    sources: { markdown: ctx.patterns(["sources", "markdown"], d.sources?.markdown) },
    index: {
      include: ctx.patterns(["index", "include"], d.index?.include),
      exclude: ctx.patterns(["index", "exclude"], d.index?.exclude),
      maxFileBytes: d.index?.max_file_bytes ?? 1_048_576,
    },
    context: { defaultBudgetTokens: d.context?.default_budget_tokens ?? 6000, maxDepth: d.context?.max_depth ?? 2 },
    review: {
      warnOnUntestedChange: d.review?.warn_on_untested_change ?? true,
      warnOnUnlinkedAddition: d.review?.warn_on_unlinked_addition ?? true,
    },
    testCommand: d.test_command ?? null,
    llm: {
      provider: d.llm?.provider ?? "none",
      model: d.llm?.model ?? null,
      apiKeyEnv: d.llm?.api_key_env ?? "OPENAI_API_KEY",
      baseUrl: d.llm?.base_url ?? null,
      transport: d.llm?.transport ?? null,
      structuredOutput: d.llm?.structured_output ?? null,
      maxCallsPerReview: d.llm?.max_calls_per_review ?? 1,
      maxInputTokens: d.llm?.max_input_tokens ?? 4000,
      timeoutMs: d.llm?.timeout_ms ?? 30000,
      cache: d.llm?.cache ?? true,
    },
    location: ctx.fallback,
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function mapVision(d: VisionFrontmatterData, body: string, location: SourceLocation, ctx: MapContext): Vision {
  return { status: d.status, owner: d.owner, sources: ctx.sources(["source"], d.source), body, location };
}

export function mapRequirement(id: string, title: string, description: string, location: SourceLocation, d: RequirementBlockData, ctx: MapContext): Requirement {
  if (d.milestone) ctx.ref("milestone", ["milestone"], d.milestone, "milestone", { type: "REQUIRES", direction: "incoming" });
  const dependsOn = ctx.refs("depends_on", ["depends_on"], d.depends_on, "requirement", { type: "REQUIRES", direction: "outgoing" });
  return {
    kind: "requirement", id, title, location, description,
    status: d.status ?? "planned",
    milestone: d.milestone ?? null,
    priority: d.priority,
    sources: ctx.sources(["source"], d.source),
    implements: { paths: ctx.patterns(["implements", "paths"], d.implements?.paths), symbols: d.implements?.symbols ?? [] },
    tests: d.tests ?? [],
    dependsOn,
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function mapIssue(
  id: string, title: string, description: string, location: SourceLocation,
  d: IssueBlockData, acceptance: readonly AcceptanceCriterion[], ctx: MapContext,
): Issue {
  const ms = d.milestone ?? null;
  if (d.milestone) ctx.ref("milestone", ["milestone"], d.milestone, "milestone");
  return {
    kind: "issue", id, title, location, description, acceptance,
    status: d.status,
    milestone: ms,
    package: d.package,
    requirements: ctx.refs("requirements", ["requirements"], d.requirements, "requirement", { type: "TRACKED_BY", direction: "incoming" }),
    decisions: ctx.refs("decisions", ["decisions"], d.decisions, "decision", { type: "GOVERNS", direction: "incoming" }),
    dependsOn: ctx.refs("depends_on", ["depends_on"], d.depends_on, "issue", { type: "REQUIRES", direction: "outgoing" }),
    implements: { paths: ctx.patterns(["implements", "paths"], d.implements?.paths) },
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function mapMilestone(
  id: string, title: string, state: MilestoneState, issues: readonly string[] | undefined, location: SourceLocation,
  extensions: Record<string, unknown> | undefined, ctx: MapContext,
): Milestone {
  const issueIds = ctx.refs("issues", ["issues"], issues, "issue");
  return { kind: "milestone", id, title, state, issues: issueIds, location, references: ctx.references, extensions: extensions ?? {} };
}

function mapDecisionContent(d: DecisionData | ProposalData, ctx: MapContext, governsRelation: boolean): DecisionContent {
  const governs = ctx.refs("governs.requirements", ["governs", "requirements"], d.governs?.requirements, "requirement",
    governsRelation ? { type: "GOVERNS", direction: "outgoing" } : undefined);
  if (d.supersedes) {
    ctx.ref("supersedes", ["supersedes"], d.supersedes, "decision", governsRelation ? { type: "SUPERSEDES", direction: "outgoing" } : undefined);
  }
  return {
    title: d.title,
    question: d.question,
    answer: d.answer,
    rationale: d.rationale,
    owner: d.owner,
    governs: { requirements: governs, paths: ctx.patterns(["governs", "paths"], d.governs?.paths), symbols: d.governs?.symbols ?? [] },
    forbids: {
      dependencies: d.forbids?.dependencies ?? [],
      symbols: d.forbids?.symbols ?? [],
      paths: ctx.patterns(["forbids", "paths"], d.forbids?.paths),
      // H-72: only when present and non-empty; absent stays absent (lock digest compatibility).
      ...((d.forbids?.imported_paths?.length ?? 0) > 0 ? { importedPaths: ctx.patterns(["forbids", "imported_paths"], d.forbids?.imported_paths) } : {}),
    },
    supersedes: d.supersedes ?? null,
    evidence: ctx.evidence(["evidence"], d.evidence),
    sources: ctx.sources(["source"], d.source),
    enforcement: d.enforcement,
  };
}

export function mapDecision(d: DecisionData, location: SourceLocation, ctx: MapContext): Decision {
  const content = mapDecisionContent(d, ctx, true);
  if (d.superseded_by) ctx.ref("superseded_by", ["superseded_by"], d.superseded_by, "decision");
  return {
    kind: "decision", id: d.id, location, ...content,
    decisionKind: d.kind ?? "decision",
    state: d.state,
    supersededBy: d.superseded_by ?? null,
    confirmedAt: d.confirmed_at,
    confirmedBy: d.confirmed_by,
    proposedAt: d.proposed_at,
    proposedBy: d.proposed_by,
    proposedByKind: d.proposed_by_kind,
    proposalId: d.proposal,
    lock: d.lock,
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function mapProposal(d: ProposalData, location: SourceLocation, ctx: MapContext): Proposal {
  const content = mapDecisionContent(d, ctx, false);
  return {
    kind: "proposal", id: d.id, location, ...content,
    state: d.state,
    proposedBy: d.proposed_by,
    proposedByKind: d.proposed_by_kind,
    proposedAt: d.proposed_at,
    basedOn: d.based_on === undefined ? undefined : { truthDigest: d.based_on.truth_digest, refs: d.based_on.refs ?? [] },
    rejectedAt: d.rejected_at,
    rejectedBy: d.rejected_by,
    reason: d.reason,
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function mapConstraint(d: ConstraintData, ctx: MapContext): Constraint {
  return {
    kind: "constraint", id: d.id, location: ctx.fallback,
    statement: d.statement,
    state: d.state,
    enforcement: d.enforcement,
    match: {
      paths: ctx.patterns(["match", "paths"], d.match?.paths),
      symbols: d.match?.symbols ?? [],
      dependencies: d.match?.dependencies ?? [],
      keywords: d.match?.keywords ?? [],
    },
    sources: ctx.sources(["source"], d.source),
    lock: d.lock,
    references: ctx.references,
    extensions: d.extensions ?? {},
  };
}

export function unknownTypeDiagnostic(type: unknown, location: SourceLocation): Diagnostic {
  return createDiagnostic("SCHEMA_INVALID_VALUE", `type: "${String(type)}" is not a definition type (requirement, issue, milestone)`, location);
}
