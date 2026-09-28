/**
 * Init domain model (TASK-014). Init creates the Project Truth Layer of an existing Git repository in
 * two steps: planInit() inspects and observes (read-only) and returns an InitPlan with the questions a
 * human must answer; applyInitPlan() writes exactly the planned files from the plan and the human's
 * answers. Indexing is the caller's next step (indexRequired), never part of init.
 *
 * Three kinds of information are kept apart:
 * - observed: facts DUO read from the repository (names, languages, manifests, documents, Git);
 * - suggested: a value DUO derived from an observation (e.g. a README paragraph); never Truth by itself;
 * - confirmed: what a human answered. Only this becomes Project Truth.
 */
import type { Diagnostic, RepoPath, WriteKind } from "@duo-director/core";
import type { WorkingTreeObservation } from "../adoption/types.js";

/**
 * not-initialized: no .duo-project, or one with no Truth or history file in it.
 * initialized: .duo-project/project.yaml exists and this build reads it.
 * partial: .duo-project holds Truth files (or entries in the way) but no project.yaml.
 * incompatible: project.yaml exists but this build cannot read it (schema version, syntax, schema).
 */
export type InitState = "not-initialized" | "initialized" | "partial" | "incompatible";

export interface ObservedFact<T> {
  readonly value: T;
  /** Where DUO read it (repository-relative path, optionally a field). */
  readonly source: { readonly path?: RepoPath; readonly field?: string; readonly kind: "manifest" | "directory" | "git" | "scan" };
}

export interface RepositoryObservation {
  readonly provenance: "observed";
  readonly name: ObservedFact<string>;
  /** Root package.json description, when present. */
  readonly description?: ObservedFact<string>;
  readonly git: { readonly branch?: string; readonly headOid?: string; readonly detached: boolean; readonly unborn: boolean; readonly shallow: boolean };
  readonly files: { readonly indexable: number; readonly excluded: Readonly<Record<string, number>> };
  /** By file count, then name. analyzed: the default LanguageAnalyzer registry parses it. */
  readonly languages: readonly { readonly language: string; readonly files: number; readonly analyzed: boolean }[];
  readonly manifests: readonly { readonly path: RepoPath; readonly kind: string }[];
  readonly packages: readonly { readonly manifest: RepoPath; readonly name?: string }[];
  readonly workspaces: readonly { readonly manifest: RepoPath; readonly patterns: readonly string[] }[];
  readonly packageManager?: ObservedFact<string>;
  /** Known build / test / lint scripts of the root manifest: names and how to run them (no raw command text). */
  readonly scripts: readonly { readonly manifest: RepoPath; readonly name: string; readonly run: string }[];
  /** Technical metadata (engines, packageManager), kept as observations: never Product Constraints. */
  readonly technical: readonly { readonly manifest: RepoPath; readonly field: string; readonly value: string }[];
  readonly sourceRoots: readonly { readonly path: string; readonly files: number }[];
  readonly testRoots: readonly { readonly path: string; readonly files: number }[];
  /** Test files next to source files (e.g. src/a.test.ts), not under a test root. */
  readonly colocatedTests: number;
  /**
   * Staged, unstaged, untracked changes outside .duo-project (T14.1). Dirty is not an init failure;
   * capturing the Adoption Baseline then needs an explicit policy (HEAD_BASELINE or ABORT_AND_CLEAN).
   */
  readonly workingTree: WorkingTreeObservation & { readonly workingTreeDirty: boolean };
}

export type DocumentKind = "readme" | "contributing" | "design" | "docs" | "package-readme" | "other";

export interface CandidateDocument {
  readonly path: RepoPath;
  readonly kind: DocumentKind;
  /** Lexical rank: location tier plus keyword bonus. Higher first; ties by path. */
  readonly score: number;
  readonly reasons: readonly string[];
  /** sha256 of the canonical text (ADR-014 provenance), when DUO read it (not over the size cap). */
  readonly hash?: string;
  /** Number of DUO definitions (metadata blocks) found in it. */
  readonly definitions: number;
}

/** Definitions found in an existing document: candidates for a human to import, never written by init. */
export interface ImportCandidate {
  readonly status: "candidate";
  readonly path: RepoPath;
  readonly hash: string;
  readonly definitions: readonly { readonly kind: "requirement" | "decision" | "issue" | "milestone"; readonly id: string; readonly title: string }[];
}

export type InitQuestionId = "project_goal" | "current_milestone" | "critical_constraints";

export interface InitQuestion {
  readonly id: InitQuestionId;
  readonly kind: "text" | "milestone" | "list";
  /** Rendering key for the CLI / UI (TASK-015); init never renders prompts. */
  readonly promptKey: string;
  /** The Truth it feeds cannot be confirmed without it. Unanswered questions become UNKNOWN(id) lines. */
  readonly required: boolean;
  /** A suggestion from an observation. Not Truth until a human accepts it. */
  readonly suggestedValue?: string;
  readonly evidence?: readonly { readonly path: RepoPath; readonly field?: string; readonly hash?: string }[];
}

export type InitAnswer =
  | { readonly question: "project_goal"; readonly value: string; readonly acceptSuggestion?: boolean }
  /** The milestone ID is allocated by the plan (allocations.milestone), like Decision IDs; the human gives the title. */
  | { readonly question: "current_milestone"; readonly title: string }
  | { readonly question: "critical_constraints"; readonly statements: readonly string[] };

export interface PlannedFile {
  readonly path: RepoPath;
  readonly kind: WriteKind;
  /** always: written on apply. answered: written only when the question is answered. */
  readonly when: "always" | "answered";
  readonly question?: InitQuestionId;
}

export interface InitConflict {
  readonly path: RepoPath;
  readonly reason: "symlink" | "not-a-directory" | "not-a-file";
}

export interface InitPlan {
  readonly format: "duo.init-plan/1";
  readonly state: InitState;
  /** False for initialized, incompatible and conflicting state: see blockers. */
  readonly applicable: boolean;
  /** partial: applying needs an explicit repair (only missing files are created). */
  readonly requiresRepair: boolean;
  readonly blockers: readonly Diagnostic[];
  readonly observed: RepositoryObservation;
  readonly documents: readonly CandidateDocument[];
  readonly importCandidates: readonly ImportCandidate[];
  readonly questions: readonly InitQuestion[];
  readonly willCreate: readonly PlannedFile[];
  readonly directories: readonly RepoPath[];
  /** Truth and history files already in .duo-project (partial, initialized). Never changed by init. */
  readonly existing: readonly RepoPath[];
  /** Layout files that do not exist yet. */
  readonly missing: readonly RepoPath[];
  readonly conflicts: readonly InitConflict[];
  /** IDs apply will use (the milestone of current_milestone). */
  readonly allocations: { readonly milestone: string };
  readonly warnings: readonly Diagnostic[];
  readonly indexRequired: true;
  /** Digest of what .duo-project looked like when planned; apply refuses when it changed (INIT_PLAN_STALE). */
  readonly basis: string;
  /** sha256 of the plan without this field; apply refuses a plan it did not produce (INIT_PLAN_INVALID). */
  readonly digest: string;
}

export interface InitApplyResult {
  readonly state: "initialized";
  readonly created: readonly RepoPath[];
  readonly directories: readonly RepoPath[];
  readonly kept: readonly RepoPath[];
  /** Questions left unanswered: written as UNKNOWN(id) lines in intent/vision.md. */
  readonly openQuestions: readonly InitQuestionId[];
  /** Init never indexes; the caller runs the Indexer next. */
  readonly indexRequired: true;
  readonly llmCalls: 0;
  readonly diagnostics: readonly Diagnostic[];
}

