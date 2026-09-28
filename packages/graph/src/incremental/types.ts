/**
 * Freshness and metrics of the incremental Indexer (TASK-008). Freshness is decided by the Indexer
 * from fingerprints, versions and dependencies; GraphStore never judges it (H-21). Each level has its
 * own states instead of one "stale" flag.
 */
import type { RepoPath } from "@duo-director/core";
import type { CallResolutionFreshness, GraphBuildStats } from "../build/types.js";

/** File level, from compareFingerprints (contentHash only, never mtime). unknown: no usable previous state. */
export type FileFreshness = "fresh" | "changed" | "added" | "deleted" | "unknown";

/**
 * SourceAnalysis level. fresh = same contentHash AND same analyzer id/version AND a cache entry.
 * stale-content: the content changed. stale-analyzer: same content, another analyzer version.
 * missing: never analyzed or no cache entry. failed: the previous analysis failed (it is retried).
 */
export type AnalysisFreshness = "fresh" | "stale-content" | "stale-analyzer" | "missing" | "failed";

/**
 * Module resolution level. stale-source: the file's analysis changed. stale-file-set: a file was
 * added or deleted (TypeScript may now pick another file). stale-config: a tsconfig/jsconfig/
 * package.json/lockfile in scope or in the file's config chain changed. stale-version: the resolver
 * version changed.
 */
export type ModuleResolutionFreshness = "fresh" | "missing" | "stale-version" | "stale-source" | "stale-file-set" | "stale-config";

export interface FileFreshnessRecord {
  readonly path: RepoPath;
  readonly file: FileFreshness;
  /** Only for files a LanguageAnalyzer supports (outside .duo-project). */
  readonly analysis?: AnalysisFreshness;
  readonly modules?: ModuleResolutionFreshness;
  readonly calls?: CallResolutionFreshness;
}

export type IndexMode = "full" | "incremental";

/** Why the Indexer rebuilt everything instead of updating. */
export type FullRebuildReason = "requested" | "no-state" | "state-invalid" | "state-unsupported" | "state-mismatch" | "incompatible";

export interface IndexMetrics {
  readonly mode: IndexMode;
  readonly fullRebuildReason?: FullRebuildReason;
  readonly files: {
    readonly total: number; readonly unchanged: number; readonly changed: number; readonly added: number; readonly deleted: number;
    /** LanguageAnalyzer.analyze() calls (AST parses). */
    readonly analyzed: number;
    readonly analysisReused: number;
    readonly analysisFailed: number;
  };
  readonly resolution: {
    readonly filesModulesRecomputed: number; readonly modulesRecomputed: number; readonly modulesReused: number;
    readonly filesCallsRecomputed: number; readonly callsRecomputed: number; readonly callsReused: number;
  };
  readonly history: { readonly recomputed: boolean; readonly commits: number };
  /**
   * Per language (analyzer language, "file-only" for files without an analyzer): files in the index,
   * parses in this run, reused analyses, failed analyses, parse time in ms (T18.0; measurement, not identity).
   */
  readonly languages: Readonly<Record<string, { readonly files: number; readonly parsed: number; readonly reused: number; readonly failed: number; readonly parseMs: number }>>;
  readonly graph: {
    readonly scopes: number; readonly scopesChanged: number;
    readonly nodesAdded: number; readonly nodesRemoved: number; readonly nodesUpdated: number;
    readonly edgesAdded: number; readonly edgesRemoved: number; readonly edgesUpdated: number;
    /** False when nothing changed and nothing was written. */
    readonly written: boolean;
  };
}

export interface IndexResult {
  readonly mode: IndexMode;
  readonly fullRebuildReason?: FullRebuildReason;
  readonly metrics: IndexMetrics;
  /** Freshness before this run, per current or deleted path (UTF-8 order): why each piece was reused or recomputed. */
  readonly freshness: readonly FileFreshnessRecord[];
  readonly stats: GraphBuildStats;
  /** meta graph_revision after the run (incremented when the graph changed). */
  readonly graphRevision: number;
}
