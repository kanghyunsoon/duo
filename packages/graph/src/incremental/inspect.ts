/**
 * Read-only index inspection (T08.1): what the Indexer would find stale and recompute, without
 * doing it. Repository scan, fingerprint, Project Truth, config, version and history comparison
 * and invalidation planning use the same decisions as indexRepository() (assess.ts). Nothing is
 * written: no graph write, no state or fingerprint file, no analysis cache entry, no revision.
 * duoctl status, MCP duo_get_status and the UI share this result; none of them has its own
 * freshness logic.
 */
import path from "node:path";
import {
  analysisLevelOf, compareFingerprints, createDefaultAnalyzerRegistry, fingerprintRepositoryFiles, openGitProvider, probeWorkTree, scanRepository,
  type AnalysisLevel, type AnalyzerCapabilities, type AnalyzerRegistry, type FileFingerprint,
} from "@duo-director/analyzer";
import { canonicalDiagnostics, compareUtf8, failure, loadProjectTruth, success, type Diagnostic, type ParseResult, type RepoPath } from "@duo-director/core";
import { CALL_RESOLUTION_VERSION, RELATION_RULES_VERSION } from "../build/builder.js";
import { HISTORY_WINDOW } from "../build/history.js";
import { MODULE_RESOLUTION_VERSION } from "../build/resolve/languages.js";
import type { CallResolutionFreshness } from "../build/types.js";
import { readCachedAnalysis } from "./analysis-cache.js";
import {
  analysisFreshnessOf, FILE_FRESHNESS, loadPreviousState, moduleFreshnessOf, resolutionSignals, STATE_PREFIX, type IndexedGraph,
} from "./assess.js";
import { INDEX_STATE_TOKEN_KEY } from "./state.js";
import type { AnalysisFreshness, FileFreshnessRecord, FullRebuildReason, ModuleResolutionFreshness } from "./types.js";

/**
 * current: an index run would write nothing. stale: the state is usable and some parts would be
 * recomputed. missing: no state (or a graph without one). incompatible: the state cannot be
 * trusted (corrupt, another version, another graph); the next run rebuilds everything.
 */
export type IndexStatus = "current" | "stale" | "missing" | "incompatible";

/**
 * Facts about how deep the current files are analyzed (T18.0): counts per language and the analyzer's
 * capabilities. No score. fileOnly files still have L0 (file, Git, diff, Truth references, evidence).
 */
export interface AnalysisCoverage {
  readonly analyzerRegistryDigest: string;
  readonly files: { readonly total: number; readonly structural: number; readonly fileOnly: number };
  readonly languages: readonly { readonly language: string; readonly files: number; readonly analyzer: string; readonly level: AnalysisLevel; readonly capabilities: AnalyzerCapabilities }[];
  /** Extensions of file-only files (most frequent first, at most 20; "" for no extension). */
  readonly fileOnlyExtensions: readonly { readonly extension: string; readonly files: number }[];
}

export interface IndexInspection {
  readonly status: IndexStatus;
  readonly fullRebuildReason?: FullRebuildReason;
  readonly coverage: AnalysisCoverage;
  /**
   * Per current or deleted path (UTF-8 order): file, analysis and module freshness exactly as the
   * Indexer decides them. predictedCalls is a prediction and an upper bound: call results that may be
   * recomputed (recomputed module results that turn out equal let the Indexer reuse them).
   */
  readonly freshness: readonly InspectFreshnessRecord[];
  readonly projectTruth: { readonly changed: readonly RepoPath[] };
  readonly configs: { readonly changed: readonly string[] };
  readonly history: { readonly recordedHead?: string; readonly currentHead?: string; readonly wouldRecompute: boolean };
  readonly wouldRebuild: {
    readonly full: boolean;
    /** Files that would be parsed. */
    readonly parse: readonly RepoPath[];
    readonly modules: readonly RepoPath[];
    /** Files whose call results may be recomputed (upper bound, not a promise). */
    readonly predictedCalls: readonly RepoPath[];
    readonly history: boolean;
    readonly projectTruth: boolean;
  };
}

export type InspectFreshnessRecord = Omit<FileFreshnessRecord, "calls"> & {
  /** Predicted call freshness (upper bound). */
  readonly predictedCalls?: CallResolutionFreshness;
};

export interface InspectOptions {
  /** Only read: the graph's schema version and metadata. */
  readonly graph: IndexedGraph;
  readonly registry?: AnalyzerRegistry;
  readonly historyWindow?: number;
  /** Benchmark observation only; excluded from freshness results. */
  readonly onPhase?: (name: string, milliseconds: number) => void;
}

export async function inspectIndex(root: string, options: InspectOptions): Promise<ParseResult<IndexInspection>> {
  let phaseStart = performance.now();
  const phase = (name: string): void => { const now = performance.now(); options.onPhase?.(name, now - phaseStart); phaseStart = now; };
  const rootDir = path.resolve(root);
  const window = options.historyWindow ?? HISTORY_WINDOW;
  const diagnostics: Diagnostic[] = [];
  const loaded = loadProjectTruth(rootDir);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.value === undefined) return failure(diagnostics);
  const { truth } = loaded.value;
  phase("truth");
  // One work-tree prefix query for this run, shared by the scan and the Git provider (T25.1).
  const workTree = probeWorkTree(rootDir);
  const scan = await scanRepository(rootDir, { include: truth.config.index.include, exclude: truth.config.index.exclude, workTree });
  diagnostics.push(...scan.diagnostics);
  if (scan.diagnostics.some((d) => d.severity === "error")) return failure(diagnostics);
  phase("scan");
  const current = (await fingerprintRepositoryFiles(rootDir, scan.files)).fingerprints;
  phase("fingerprint");

  const { previous, fullRebuildReason, diagnostics: stateDiagnostics } = loadPreviousState(rootDir, options.graph, window, false);
  phase("state");
  diagnostics.push(...stateDiagnostics);
  const changes = compareFingerprints(previous?.files ?? [], current);
  const prevFiles = new Map((previous?.files ?? []).map((f) => [f.path, f] as const));

  let registry = options.registry;
  if (registry === undefined) {
    const created = await createDefaultAnalyzerRegistry();
    diagnostics.push(...created.diagnostics);
    if (created.value === undefined) return failure(diagnostics);
    registry = created.value;
  }
  phase("registry");
  const analysis = new Map<RepoPath, AnalysisFreshness>();
  const changedFiles = new Set<string>(changes.filter((c) => c.status === "DELETED").map((c) => c.path));
  const indexed = current.map((f) => f.path).filter((p) => !p.startsWith(STATE_PREFIX));
  const selection = registry.scope(indexed);
  const byLanguage = new Map<string, { files: number; analyzer: string; capabilities: AnalyzerCapabilities }>();
  const fileOnly = new Map<string, number>();
  const analyzerRegistryDigest = registry.digest();
  try {
    for (const f of current) {
      if (f.path.startsWith(STATE_PREFIX)) continue;
      const analyzer = selection.analyzerFor(f.path);
      if (analyzer === undefined) {
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        const ext = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
        fileOnly.set(ext, (fileOnly.get(ext) ?? 0) + 1);
        continue;
      }
      const language = selection.languageFor(f.path) ?? analyzer.id;
      const entry = byLanguage.get(language) ?? { files: 0, analyzer: analyzer.id, capabilities: analyzer.capabilities };
      byLanguage.set(language, { ...entry, files: entry.files + 1 });
      let freshness = analysisFreshnessOf(previous, prevFiles.get(f.path), f, analyzer);
      if (freshness === "fresh" && readCachedAnalysis(rootDir, { path: f.path, contentHash: f.contentHash, analyzer: analyzer.id, analyzerIdentity: analyzer.identity }) === undefined) {
        freshness = "missing";
      }
      analysis.set(f.path, freshness);
      if (freshness !== "fresh") changedFiles.add(f.path);
    }
  } finally {
    if (options.registry === undefined) registry.dispose();
  }
  phase("analysis");
  for (const [p, f] of prevFiles) if (f.resolution !== undefined && !analysis.has(p)) changedFiles.add(p);

  const signals = resolutionSignals(rootDir, changes, previous);
  const modules = new Map<RepoPath, ModuleResolutionFreshness>();
  for (const p of analysis.keys()) {
    modules.set(p, moduleFreshnessOf(p, prevFiles.get(p)?.resolution, previous, MODULE_RESOLUTION_VERSION, changedFiles, signals));
  }
  const moduleWillChange = (p: string) => changedFiles.has(p) || (modules.get(p as RepoPath) ?? "fresh") !== "fresh";
  const calls = new Map<RepoPath, CallResolutionFreshness>();
  for (const p of analysis.keys()) {
    const prev = prevFiles.get(p)?.resolution;
    let c: CallResolutionFreshness;
    if (previous === undefined || prev === undefined) c = "missing";
    else if (previous.callResolutionVersion !== CALL_RESOLUTION_VERSION) c = "stale-version";
    else if (changedFiles.has(p)) c = "stale-source";
    else if (modules.get(p) !== "fresh") c = "stale-modules";
    else if (prev.exportDependencies.some(moduleWillChange)) c = "stale-dependency";
    else c = "fresh";
    calls.set(p, c);
  }

  const git = await openGitProvider(rootDir, { workTree });
  const repo = git.value === undefined ? undefined : (await git.value.repositoryState()).value;
  const recordedHead = previous?.history?.headOid;
  const wouldRecomputeHistory = repo?.headOid !== undefined
    && (previous?.history === undefined || recordedHead !== repo.headOid || previous.history.shallow !== repo.shallow);
  const repositoryMoved = previous !== undefined && (previous.git?.headOid !== repo?.headOid || previous.git?.branch !== repo?.branch
    || (previous.git?.detached ?? false) !== (repo?.detached ?? false));
  phase("resolution-and-git");

  const truthChanged = changes.filter((c) => c.path.startsWith(STATE_PREFIX) && c.status !== "UNCHANGED").map((c) => c.path);
  // Builder relation rules changed since the state was written (T24.5): Truth and annotation relations are made again.
  const relationRulesChanged = previous !== undefined && previous.relationRulesVersion !== RELATION_RULES_VERSION;
  // A state or blob OID change with the same content is UNCHANGED for compareFingerprints but still rewrites the File payload or the state.
  const fingerprintsIdentical = changes.every((c) => c.status === "UNCHANGED" && sameFingerprint(c.previous, c.current));
  const parse = [...analysis].filter(([, f]) => f !== "fresh").map(([p]) => p).sort(compareUtf8);
  const moduleList = [...modules].filter(([, f]) => f !== "fresh").map(([p]) => p).sort(compareUtf8);
  const callList = [...calls].filter(([, f]) => f !== "fresh").map(([p]) => p).sort(compareUtf8);
  let status: IndexStatus;
  if (previous === undefined) {
    status = fullRebuildReason === "no-state" || options.graph.readMeta(INDEX_STATE_TOKEN_KEY) === undefined ? "missing" : "incompatible";
  } else {
    const idle = fingerprintsIdentical && parse.length === 0 && moduleList.length === 0 && callList.length === 0 && !wouldRecomputeHistory
      && !repositoryMoved && signals.changedConfigs.size === 0 && !relationRulesChanged;
    status = idle ? "current" : "stale";
  }
  const freshness: InspectFreshnessRecord[] = changes.map((c) => {
    const a = analysis.get(c.path);
    const m = modules.get(c.path);
    const k = calls.get(c.path);
    return {
      path: c.path, file: previous === undefined ? "unknown" : FILE_FRESHNESS[c.status],
      ...(a === undefined ? {} : { analysis: a }), ...(m === undefined ? {} : { modules: m }), ...(k === undefined ? {} : { predictedCalls: k }),
    };
  });
  const structural = [...byLanguage.values()].reduce((n, l) => n + l.files, 0);
  const coverage: AnalysisCoverage = {
    analyzerRegistryDigest,
    files: { total: indexed.length, structural, fileOnly: indexed.length - structural },
    languages: [...byLanguage].sort(([a], [b]) => compareUtf8(a, b)).map(([language, l]) => ({ language, files: l.files, analyzer: l.analyzer, level: analysisLevelOf(l.capabilities), capabilities: l.capabilities })),
    fileOnlyExtensions: [...fileOnly].sort(([a, x], [b, y]) => y - x || compareUtf8(a, b)).slice(0, 20).map(([extension, files]) => ({ extension, files })),
  };
  return success({
    status, ...(fullRebuildReason === undefined ? {} : { fullRebuildReason }), coverage,
    freshness,
    projectTruth: { changed: truthChanged },
    configs: { changed: [...signals.changedConfigs].sort(compareUtf8) },
    history: { ...(recordedHead === undefined ? {} : { recordedHead }), ...(repo?.headOid === undefined ? {} : { currentHead: repo.headOid }), wouldRecompute: wouldRecomputeHistory },
    wouldRebuild: {
      full: previous === undefined, parse, modules: moduleList, predictedCalls: callList, history: wouldRecomputeHistory, projectTruth: truthChanged.length > 0 || relationRulesChanged,
    },
  }, canonicalDiagnostics(diagnostics));
}

function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
  return a !== undefined && b !== undefined && a.state === b.state && a.fingerprintMode === b.fingerprintMode && a.contentHash === b.contentHash
    && a.size === b.size && a.gitBlobOid === b.gitBlobOid;
}
