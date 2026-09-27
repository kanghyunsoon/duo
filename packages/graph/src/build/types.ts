/**
 * Graph Builder contract (TASK-007): facts in, a validated plan out. Building never writes; the
 * plan is applied in one GraphStore transaction (apply.ts).
 */
import type { CoChangeCandidate, FileFingerprint, GitRepositoryState, ModuleReferenceKind, SourceAnalysis } from "@duo-director/analyzer";
import type { Diagnostic, EntityType, ProjectTruth, RepoPath, SourceLocation, SymbolRef, TraceModel } from "@duo-director/core";
import type { GraphEdgeInput, GraphEdgeType, GraphNodeInput } from "../store/types.js";
import type { ModuleResolution, ModuleResolutionStatus, ModuleResolver } from "./resolve/module-resolver.js";

export interface AnalyzedFile {
  readonly analysis: SourceAnalysis;
  readonly analyzerVersion: string;
}

/**
 * What the builder needs from Git history (the newest HISTORY_WINDOW commits of HEAD). Derived
 * facts only, no commit messages: the Indexer keeps it while HEAD does not move (TASK-008).
 */
export interface HistorySummary {
  /** Commits in the window. */
  readonly commitCount: number;
  /** sha256 of the window's commit OIDs in log order. */
  readonly windowFingerprint: string;
  /** computeCoChangeCandidates over the window (04 CHANGED_WITH rule). */
  readonly coChange: readonly CoChangeCandidate[];
  /** Issue key candidates from commit messages → commit OIDs, newest first (at most 20). Not yet checked against Project Truth. */
  readonly issueCommits: Readonly<Record<string, readonly string[]>>;
}

export interface GraphBuildInput {
  readonly truth: ProjectTruth;
  readonly trace: TraceModel;
  /** Indexed files (T04 fingerprints). */
  readonly files: readonly FileFingerprint[];
  readonly analyses: readonly AnalyzedFile[];
  /** Supported source files whose analysis failed (decode error, timeout). */
  readonly failedAnalyses?: readonly RepoPath[];
  /** Working-tree text of analyzed files (annotation attachment reads the gap between comment and code). */
  readonly sourceText: (path: RepoPath) => string | undefined;
  readonly moduleResolver: ModuleResolver;
  readonly git?: { readonly state?: GitRepositoryState; readonly history?: HistorySummary };
}

/**
 * Why an edge exists (TASK-008), stored as metadata.categories. It names the inputs whose change
 * can add or remove the edge: project-truth (Project Truth documents), source-analysis (scan and
 * SourceAnalysis), module-resolution (module references, file set, config), call-resolution (call
 * sites and the export surfaces they read), annotation ("duo:" comments and Truth IDs), test
 * (exact calls inside tests), git-history (the commit window).
 */
export type EdgeCategory = "project-truth" | "source-analysis" | "module-resolution" | "call-resolution" | "annotation" | "test" | "git-history";

export type CallResolutionStatus = "exact" | "heuristic" | "ambiguous" | "unresolved";

export interface CallResolution {
  readonly path: RepoPath;
  readonly calleeText: string;
  readonly location: SourceLocation;
  readonly status: CallResolutionStatus;
  /** Why the call is not exact (e.g. "receiver-type-unknown", "local-binding", "external-module"). */
  readonly reason?: string;
  readonly target?: SymbolRef;
  readonly source?: SymbolRef;
}

export interface ModuleResolutionRecord {
  readonly from: RepoPath;
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  readonly location: SourceLocation;
  readonly result: ModuleResolution;
}

export interface GraphBuildStats {
  readonly nodes: Readonly<Record<EntityType, number>>;
  readonly edges: Readonly<Record<GraphEdgeType, number>>;
  readonly modules: Readonly<Record<ModuleResolutionStatus, number>>;
  readonly calls: Readonly<Record<CallResolutionStatus, number>> & { readonly exactWithoutSourceSymbol: number };
  readonly annotations: { readonly symbol: number; readonly test: number; readonly file: number; readonly unknownId: number; readonly unsupportedId: number };
}

/** A call result as stored between runs: the target is a symbol identity in a file. */
export interface StoredCallOutcome {
  readonly status: CallResolutionStatus;
  readonly reason?: string;
  readonly target?: { readonly file: RepoPath; readonly symbol: string };
}

/** Resolution results of one analyzed file with the dependencies that decide their validity (TASK-008). */
export interface FileResolution {
  /** One result per SourceAnalysis.moduleReferences entry, same order. */
  readonly modules: readonly ModuleResolution[];
  /** One result per SourceAnalysis.callSites entry, same order. */
  readonly calls: readonly StoredCallOutcome[];
  /** Other files the call results read through export lookups (target modules, re-export chains). UTF-8 order. */
  readonly exportDependencies: readonly RepoPath[];
  /** Config files that decided the module results (ModuleResolver.configFiles). */
  readonly configFiles: readonly RepoPath[];
}

export type CallResolutionFreshness = "fresh" | "missing" | "stale-version" | "stale-source" | "stale-modules" | "stale-dependency";

/**
 * Previous resolution results for an incremental build (TASK-008). The Indexer decides which module
 * results are reusable; the builder decides call reuse from module results and export dependencies.
 * Without a memo everything is resolved (the full build, which is the oracle).
 */
export interface ResolutionMemo {
  readonly previous: ReadonlyMap<RepoPath, FileResolution>;
  /** Files whose stored module results are still valid (same analysis, no file-set or config change, same version). */
  readonly reusableModules: ReadonlySet<RepoPath>;
  /** Files whose analysis differs from the one the stored results came from, and deleted files. */
  readonly changedFiles: ReadonlySet<RepoPath>;
  /** The call resolution rules changed: no stored call result is reused. */
  readonly callVersionChanged: boolean;
}

export interface ResolutionWork {
  readonly filesModulesRecomputed: number;
  readonly modulesRecomputed: number;
  readonly modulesReused: number;
  readonly filesCallsRecomputed: number;
  readonly callsRecomputed: number;
  readonly callsReused: number;
  /** Per analyzed file: why its call results were (not) reused. */
  readonly callFreshness: ReadonlyMap<RepoPath, CallResolutionFreshness>;
}

export interface GraphBuildPlan {
  /** In node ID order (UTF-8). */
  readonly nodes: readonly GraphNodeInput[];
  /** In (from, type, to) order (UTF-8). */
  readonly edges: readonly GraphEdgeInput[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: GraphBuildStats;
  readonly moduleResolutions: readonly ModuleResolutionRecord[];
  readonly callResolutions: readonly CallResolution[];
  /** Resolution results per analyzed file, for the next incremental build. */
  readonly resolution: ReadonlyMap<RepoPath, FileResolution>;
  readonly resolutionWork: ResolutionWork;
  /** False when validation found an error (conflicting node, invalid payload or endpoint): the plan must not be applied. */
  readonly valid: boolean;
}
