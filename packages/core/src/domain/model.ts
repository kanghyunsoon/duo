/**
 * DUO domain model. Independent of file formats and parser libraries: these types never
 * reference YAML or Markdown AST types.
 */
import type { SourceLocation } from "../diagnostics.js";
import type { EntityType } from "../ids.js";
import type { RepoPath } from "../paths.js";

/** Edge types implied by definition references (canonical direction, docs/04-project-graph.md). */
export type TraceRelation = "GOVERNS" | "TRACKED_BY" | "REQUIRES";

/** A reference written in a definition, kept with its exact source position. */
export interface DeclaredReference {
  /** Field that holds the reference, e.g. "requirements" or "governs.requirements". */
  readonly field: string;
  readonly target: string;
  readonly expected: EntityType;
  /**
   * Edge implied by the reference. "outgoing": owner → target, "incoming": target → owner.
   * Undefined means the reference is only checked for existence.
   */
  readonly relation?: { readonly type: TraceRelation; readonly direction: "outgoing" | "incoming" } | undefined;
  readonly location: SourceLocation;
}

export type SourceRef =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "external"; readonly path: RepoPath; readonly hash: string; readonly section?: string | undefined };

export type EvidenceKind =
  | "requirement" | "decision" | "constraint" | "issue" | "milestone" | "file" | "symbol" | "test"
  | "commit" | "diff" | "document" | "review" | "llm";

export interface EvidencePointer {
  readonly kind: EvidenceKind;
  readonly id?: string | undefined;
  readonly path?: RepoPath | undefined;
  readonly symbol?: string | undefined;
  readonly lines?: readonly [number, number] | undefined;
  readonly commit?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly change?: "added" | "modified" | "removed" | undefined;
}

interface DefinitionBase {
  readonly id: string;
  readonly location: SourceLocation;
  readonly references: readonly DeclaredReference[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type RequirementStatus = "planned" | "in_progress" | "done" | "deferred";
export type Priority = "must" | "should" | "could";

export interface Requirement extends DefinitionBase {
  readonly kind: "requirement";
  readonly title: string;
  readonly status: RequirementStatus;
  readonly milestone: string | null;
  readonly priority?: Priority | undefined;
  readonly sources: readonly SourceRef[];
  readonly implements: { readonly paths: readonly string[]; readonly symbols: readonly string[] };
  readonly tests: readonly string[];
  readonly dependsOn: readonly string[];
  readonly description: string;
}

export type IssueStatus = "todo" | "in_progress" | "review" | "done";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly location: SourceLocation;
}

export interface Issue extends DefinitionBase {
  readonly kind: "issue";
  readonly title: string;
  readonly status: IssueStatus;
  readonly milestone: string | null;
  readonly package?: string | undefined;
  readonly requirements: readonly string[];
  readonly decisions: readonly string[];
  readonly dependsOn: readonly string[];
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly description: string;
}

export type MilestoneState = "planned" | "active" | "done";

export interface Milestone extends DefinitionBase {
  readonly kind: "milestone";
  readonly title: string;
  readonly state: MilestoneState;
}

export interface DecisionContent {
  readonly title: string;
  readonly question: string;
  readonly answer: string;
  readonly rationale?: string | undefined;
  readonly owner?: "human" | undefined;
  readonly governs: { readonly requirements: readonly string[]; readonly paths: readonly string[]; readonly symbols: readonly string[] };
  readonly forbids: { readonly dependencies: readonly string[]; readonly symbols: readonly string[]; readonly paths: readonly string[] };
  readonly supersedes: string | null;
  readonly evidence: readonly EvidencePointer[];
  readonly sources: readonly SourceRef[];
}

export type DecisionState = "proposed" | "confirmed" | "superseded" | "rejected";

export interface Decision extends DefinitionBase, DecisionContent {
  readonly kind: "decision";
  readonly decisionKind: "decision" | "constraint";
  readonly state: DecisionState;
  readonly supersededBy: string | null;
  readonly confirmedAt?: string | undefined;
  readonly confirmedBy?: string | undefined;
  readonly proposedAt?: string | undefined;
  readonly proposedBy?: string | undefined;
  readonly lock?: { readonly digest: string } | undefined;
}

/** Decision proposal. Not a Project Graph entity (docs/04). */
export interface Proposal extends DecisionContent {
  readonly kind: "proposal";
  readonly id: string;
  readonly state: "proposed" | "rejected";
  readonly proposedBy: string;
  readonly proposedAt?: string | undefined;
  readonly rejectedAt?: string | undefined;
  readonly rejectedBy?: string | undefined;
  readonly reason?: string | undefined;
  readonly location: SourceLocation;
  readonly references: readonly DeclaredReference[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export type ConstraintState = "draft" | "confirmed" | "retired";

/** Constraint. A Decision-type entity (kind constraint) in the Project Graph (docs/conflicts.md C14). */
export interface Constraint extends DefinitionBase {
  readonly kind: "constraint";
  readonly statement: string;
  readonly state: ConstraintState;
  readonly enforcement: "warn" | "block";
  readonly match: {
    readonly paths: readonly string[];
    readonly symbols: readonly string[];
    readonly dependencies: readonly string[];
    readonly keywords: readonly string[];
  };
  readonly sources: readonly SourceRef[];
  readonly lock?: { readonly digest: string } | undefined;
}

export interface Vision {
  readonly status: "draft" | "confirmed";
  readonly owner?: "human" | undefined;
  readonly sources: readonly SourceRef[];
  readonly body: string;
  readonly location: SourceLocation;
}

export interface ProjectConfig {
  readonly schemaVersion: number;
  readonly name: string;
  readonly currentMilestone: string | null;
  readonly sources: { readonly markdown: readonly string[] };
  readonly index: { readonly include: readonly string[]; readonly exclude: readonly string[]; readonly maxFileBytes: number };
  readonly context: { readonly defaultBudgetTokens: number; readonly maxDepth: number };
  readonly review: { readonly warnOnUntestedChange: boolean; readonly warnOnUnlinkedAddition: boolean };
  readonly testCommand: string | null;
  readonly llm: {
    readonly provider: "none" | "openai-responses";
    readonly model: string | null;
    readonly apiKeyEnv: string;
    readonly baseUrl: string | null;
    readonly maxCallsPerReview: number;
    readonly maxInputTokens: number;
    readonly timeoutMs: number;
  };
  readonly location: SourceLocation;
  readonly references: readonly DeclaredReference[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

/** Graph-entity definitions (everything with a global ID). */
export type Definition = Requirement | Decision | Constraint | Issue | Milestone;

export interface DefinitionSet {
  readonly requirements: readonly Requirement[];
  readonly decisions: readonly Decision[];
  readonly constraints: readonly Constraint[];
  readonly issues: readonly Issue[];
  readonly milestones: readonly Milestone[];
  readonly proposals: readonly Proposal[];
}

export interface ProjectTruth extends DefinitionSet {
  readonly config: ProjectConfig;
  readonly vision: Vision | undefined;
  /** Definition files that were read, repository-relative. */
  readonly files: readonly RepoPath[];
}

export function emptyDefinitionSet(): { -readonly [K in keyof DefinitionSet]: DefinitionSet[K][number][] } {
  return { requirements: [], decisions: [], constraints: [], issues: [], milestones: [], proposals: [] };
}
