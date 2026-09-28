/**
 * Claim construction (TASK-013). A claim exists only with evidence: rules pass evidence IDs and a
 * claim without any is dropped. Its basis is the union of the evidence's bases; blockEligible is
 * computed here once, from the T12A policy: CONFLICT AND an enforced rule AND Project Truth AND
 * observable evidence (repository, git, test). LLM evidence never makes a claim block.
 */
import type { GitDiffEnd, GitProvider } from "@duo-director/analyzer";
import { compareUtf8, definitionRef, sha256Text, type Diagnostic, type EvidenceBasis, type ProjectTruth } from "@duo-director/core";
import type { GraphNode, GraphReader } from "@duo-director/graph";
import type { SourceReader } from "../context/retrieve.js";
import type { ContextPacket } from "../context/types.js";
import { repositoryEvidence, truthEvidence } from "../evidence/sources.js";
import type { EvidenceStore } from "../evidence/store.js";
import { blockEligible } from "../llm/contract/evidence.js";
import type { Alignment, ChangedFile, DiffSeed, ReviewClaim, ReviewRule, TestRunEvidence } from "./types.js";

export interface RuleContext {
  readonly root: string;
  readonly truth: ProjectTruth;
  readonly graph: GraphReader;
  readonly git: GitProvider;
  readonly files: readonly ChangedFile[];
  readonly seeds: readonly DiffSeed[];
  readonly store: EvidenceStore;
  readonly reader: SourceReader;
  readonly identity: string;
  readonly from: GitDiffEnd;
  readonly to: GitDiffEnd;
  readonly toLabel: string;
  readonly fromLabel: string;
  readonly task: string;
  readonly reviewPacket?: ContextPacket;
  /** Node IDs of the task-only context (items and omitted candidates); undefined without a task. */
  readonly taskScope?: ReadonlySet<string>;
  readonly stateDiagnostics: readonly Diagnostic[];
  readonly testResults?: TestRunEvidence;
  /** Violation keys of the Adoption Baseline; undefined when there is no usable baseline (T14.1). */
  readonly baselineKeys?: ReadonlySet<string>;
}

export interface ClaimInput {
  readonly rule: ReviewRule;
  readonly subject: { readonly kind: string; readonly id: string };
  /** Distinguishes several claims of one rule and subject (a forbidden path, a failed test). */
  readonly key?: string;
  readonly alignment: Alignment;
  readonly expected: string;
  readonly observed: string;
  readonly reason: string;
  readonly evidence: readonly (string | undefined)[];
  readonly enforced?: boolean;
  readonly drift?: boolean;
  readonly semantic?: boolean;
  /** Baseline rules: the stable violation key and whether this diff changed the offending or governing entity. */
  readonly violation?: { readonly key: string; readonly touched: boolean };
}

const BASIS_ORDER: readonly EvidenceBasis[] = ["project-truth", "repository", "git", "test", "llm"];

export function claimId(rule: ReviewRule, subject: string, key: string, identity: string): string {
  return `claim-${sha256Text(`${rule}\n${subject}\n${key}\n${identity}`).slice(7, 23)}`;
}

export function makeClaim(ctx: RuleContext, input: ClaimInput): ReviewClaim | undefined {
  const evidenceIds = [...new Set(input.evidence.filter((e): e is string => e !== undefined))].sort(compareUtf8);
  if (evidenceIds.length === 0) return undefined;
  const bases = new Set(evidenceIds.flatMap((id) => ctx.store.get(id)?.basis ?? []));
  const basis = BASIS_ORDER.filter((b) => bases.has(b));
  const enforced = input.enforced ?? false;
  // T14.1: a violation that existed at adoption never blocks; touched by this diff it still warns, untouched it is history.
  const v = input.violation;
  const provenance = v === undefined || ctx.baselineKeys === undefined || input.alignment === "ALIGNED" ? undefined
    : !ctx.baselineKeys.has(v.key) ? "introduced" as const : v.touched ? "pre-existing-touched" as const : "pre-existing" as const;
  const preExisting = provenance === "pre-existing" || provenance === "pre-existing-touched";
  return {
    id: claimId(input.rule, `${input.subject.kind}:${input.subject.id}`, input.key ?? "", ctx.identity),
    rule: input.rule, subject: input.subject, expected: input.expected, observed: input.observed, alignment: input.alignment,
    evidenceIds, basis, reason: input.reason, enforced,
    blockEligible: input.alignment === "CONFLICT" && enforced && blockEligible(basis) && !preExisting,
    drift: input.drift ?? false, semanticCandidate: input.semantic ?? false,
    ...(v === undefined ? {} : { violationKey: v.key }), ...(provenance === undefined ? {} : { provenance }),
  };
}

// ---- evidence helpers shared by the rules ----

export function requirementEvidence(ctx: RuleContext, id: string): string | undefined {
  const r = ctx.truth.requirements.find((x) => x.id === id);
  return r === undefined ? undefined : truthEvidence(ctx.store, ctx.reader, { kind: "requirement", id, title: r.title, location: r.location });
}

export function decisionEvidence(ctx: RuleContext, id: string): string | undefined {
  const d = ctx.truth.decisions.find((x) => x.id === id);
  if (d !== undefined) return truthEvidence(ctx.store, ctx.reader, { kind: "decision", id, title: d.title, location: d.location });
  const c = ctx.truth.constraints.find((x) => x.id === id);
  // A constraint entry starts after "- "; its evidence is the entry from column 1 (as in the Packet).
  return c === undefined ? undefined : truthEvidence(ctx.store, ctx.reader, {
    kind: "constraint", id, title: c.statement, location: c.location.startLine === undefined ? c.location : { ...c.location, startColumn: 1 },
  });
}

export function nodeEvidence(ctx: RuleContext, node: GraphNode | undefined): string | undefined {
  return node === undefined ? undefined : repositoryEvidence(ctx.store, ctx.reader, node, ctx.toLabel);
}

/** Repository evidence of a seed plus the hunks that touch it. */
export function seedEvidence(ctx: RuleContext, seed: DiffSeed): (string | undefined)[] {
  return [nodeEvidence(ctx, ctx.graph.getNode(seed.entity)), ...seed.evidenceIds];
}

export function isActive(d: { readonly state: string; readonly supersededBy: string | null }): boolean {
  return d.state === "confirmed" && d.supersededBy === null;
}

export function requirementRef(id: string) {
  return definitionRef("requirement", id);
}
