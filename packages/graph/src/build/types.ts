/**
 * Graph Builder contract (TASK-007): facts in, a validated plan out. Building never writes; the
 * plan is applied in one GraphStore transaction (apply.ts).
 */
import type { FileFingerprint, GitCommit, GitRepositoryState, ModuleReferenceKind, SourceAnalysis } from "@duo-director/analyzer";
import type { Diagnostic, EntityType, ProjectTruth, RepoPath, SourceLocation, SymbolRef, TraceModel } from "@duo-director/core";
import type { GraphEdgeInput, GraphEdgeType, GraphNodeInput } from "../store/types.js";
import type { ModuleResolution, ModuleResolutionStatus, ModuleResolver } from "./resolve/module-resolver.js";

export interface AnalyzedFile {
  readonly analysis: SourceAnalysis;
  readonly analyzerVersion: string;
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
  readonly git?: { readonly state?: GitRepositoryState; readonly commits?: readonly GitCommit[] };
}

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

export interface GraphBuildPlan {
  /** In node ID order (UTF-8). */
  readonly nodes: readonly GraphNodeInput[];
  /** In (from, type, to) order (UTF-8). */
  readonly edges: readonly GraphEdgeInput[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: GraphBuildStats;
  readonly moduleResolutions: readonly ModuleResolutionRecord[];
  readonly callResolutions: readonly CallResolution[];
  /** False when validation found an error (conflicting node, invalid payload or endpoint): the plan must not be applied. */
  readonly valid: boolean;
}
