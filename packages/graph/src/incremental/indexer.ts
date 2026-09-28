/**
 * Incremental Indexer (TASK-008). Invariant: the graph after an incremental run equals the graph a
 * clean full rebuild produces for the same repository state (04 invariant 5).
 *
 * The full builder (buildGraphPlan) is the only plan generator. The Indexer feeds it the same facts a
 * clean build would collect, but reuses the expensive parts whose inputs did not change:
 *   - SourceAnalysis: reused when contentHash and the analyzer identity are the same (no AST parse);
 *     a new or changed analyzer re-analyzes exactly the files it (now) claims (T18.0);
 *   - module resolution: reused unless the file, the indexed file set or a config in scope changed;
 *   - call resolution: reused unless the file, its module results or a file its export lookups read
 *     changed (decided inside the builder);
 *   - Git history window: reused while HEAD (and shallowness) is the same, else recomputed whole.
 * Everything else (Project Truth relations, annotations, VALIDATED_BY, CHANGED_WITH filtering) is
 * cheap and recomputed. The new plan is compared per scope with the stored digests; only changed
 * scopes are read and rewritten, in one transaction that also stores the state token.
 */
import fs from "node:fs";
import path from "node:path";
import {
  compareFingerprints, createDefaultAnalyzerRegistry, fingerprintRepositoryFiles, openGitProvider, scanRepository, writeFingerprintFile,
  type AnalyzerRegistry, type FileFingerprint, type GitRepositoryState,
} from "@duo-director/analyzer";
import {
  canonicalDiagnostics, checkWriteBoundary, compareUtf8, createDiagnostic, failure, loadProjectTruth, persistentDiagnostics, STATE_DIR_NAME, success,
  type Diagnostic, type ParseResult, type RepoPath,
} from "@duo-director/core";
import { replaceGraph } from "../build/apply.js";
import { buildGraphPlan, CALL_RESOLUTION_VERSION } from "../build/builder.js";
import { HISTORY_WINDOW, summarizeHistory } from "../build/history.js";
import { createLanguageModuleResolver } from "../build/resolve/languages.js";
import { fileScope, scopeDigests, TRUTH_SCOPE } from "../build/scope.js";
import type { AnalyzedFile, FileResolution, HistorySummary, ResolutionMemo } from "../build/types.js";
import { openNodeSqliteGraphStore } from "../store/node-sqlite/node-sqlite-graph-store.js";
import { GraphStoreError, type GraphOpenResult, type GraphStore } from "../store/types.js";
import { pruneAnalysisCache, readCachedAnalysis, writeCachedAnalysis, type AnalysisCacheKey } from "./analysis-cache.js";
import {
  analysisFreshnessOf, FILE_FRESHNESS, hashOnDisk, loadPreviousState, moduleFreshnessOf, resolutionSignals, STATE_PREFIX,
} from "./assess.js";
import { applyGraphDiff, diffScopes, type GraphDiff } from "./diff.js";
import {
  GRAPH_REVISION_KEY, INDEX_STATE_FORMAT, INDEX_STATE_TOKEN_KEY, INDEX_STATE_VERSION, indexStateToken, writeIndexState,
  type IndexedFileState, type IndexState,
} from "./state.js";
import type { AnalysisFreshness, FileFreshnessRecord, IndexMetrics, IndexResult, ModuleResolutionFreshness } from "./types.js";

export { isResolutionConfigFile } from "./assess.js";

export const GRAPH_DB_FILE_PATH = `${STATE_DIR_NAME}/generated/graph.db`;

/**
 * Opens the project's graph database (.duo-project/generated/graph.db), creating the directory. A
 * database of another graph_schema_version is generated data and is recreated (ADR-002).
 */
export function openProjectGraphStore(root: string): GraphOpenResult {
  const rootDir = path.resolve(root);
  const allowed = checkWriteBoundary(rootDir, GRAPH_DB_FILE_PATH, "regenerable");
  if (allowed.value === undefined) return { diagnostics: allowed.diagnostics, regenerable: false };
  const file = path.join(rootDir, allowed.value.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return openNodeSqliteGraphStore({ path: file, onUnsupportedSchema: "recreate" });
}

/**
 * Opens the project's graph for reading only (T15: status, context, review, trace, impact write
 * nothing). Without a graph.db nothing is created: an empty in-memory graph stands in, which
 * inspectIndex() reports as missing. An incompatible database is reported, never recreated.
 */
export function openProjectGraphReader(root: string): GraphOpenResult {
  const file = path.join(path.resolve(root), GRAPH_DB_FILE_PATH);
  if (!fs.existsSync(file)) return openNodeSqliteGraphStore({ path: ":memory:" });
  return openNodeSqliteGraphStore({ path: file, readOnly: true });
}

export interface IndexOptions {
  readonly store: GraphStore;
  /** Analyzers; default: the TypeScript/JavaScript registry (disposed after the run). */
  readonly registry?: AnalyzerRegistry;
  /** Ignore the stored state and rebuild the whole graph. */
  readonly full?: boolean;
  /** Commits in the history window. Default HISTORY_WINDOW (500, 04). */
  readonly historyWindow?: number;
}

/** Digest of a scope without rows (the Project Truth scope always has the Project node, so this is a fallback). */
const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;

export async function indexRepository(root: string, options: IndexOptions): Promise<ParseResult<IndexResult>> {
  const rootDir = path.resolve(root);
  const { store } = options;
  const window = options.historyWindow ?? HISTORY_WINDOW;
  const diagnostics: Diagnostic[] = [];

  // ---- facts that are always read (cheap: no AST) ----
  const loaded = loadProjectTruth(rootDir);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.value === undefined) return failure(diagnostics);
  const { truth, trace } = loaded.value;
  const scan = await scanRepository(rootDir, { include: truth.config.index.include, exclude: truth.config.index.exclude });
  diagnostics.push(...scan.diagnostics);
  if (scan.diagnostics.some((d) => d.severity === "error")) return failure(diagnostics);
  const fingerprinted = await fingerprintRepositoryFiles(rootDir, scan.files);
  diagnostics.push(...fingerprinted.diagnostics);
  const current: readonly FileFingerprint[] = fingerprinted.fingerprints;

  // ---- previous state: any doubt means a full rebuild ----
  const loadedState = loadPreviousState(rootDir, store, window, options.full === true);
  diagnostics.push(...loadedState.diagnostics);
  const { previous, fullRebuildReason } = loadedState;
  const mode = previous === undefined ? "full" : "incremental";
  const prevFiles = new Map((previous?.files ?? []).map((f) => [f.path, f] as const));
  const changes = compareFingerprints(previous?.files ?? [], current);
  const fileFreshness = new Map(changes.map((c) => [c.path, previous === undefined ? "unknown" : FILE_FRESHNESS[c.status]] as const));
  const deleted = changes.filter((c) => c.status === "DELETED").map((c) => c.path);

  // ---- analyses: parse only what is not fresh ----
  let registry = options.registry;
  if (registry === undefined) {
    const created = await createDefaultAnalyzerRegistry();
    diagnostics.push(...created.diagnostics);
    if (created.value === undefined) return failure(diagnostics);
    registry = created.value;
  }
  const selection = registry.scope(current.map((f) => f.path).filter((p) => !p.startsWith(STATE_PREFIX)));
  const analyzerIdentities = registry.identities();
  const analyzerRegistryDigest = registry.digest();
  const languages: Record<string, { files: number; parsed: number; reused: number; failed: number; parseMs: number }> = {};
  const lang = (key: string) => (languages[key] ??= { files: 0, parsed: 0, reused: 0, failed: 0, parseMs: 0 });
  const analyses: AnalyzedFile[] = [];
  const failedAnalyses: RepoPath[] = [];
  const analysisFreshness = new Map<RepoPath, AnalysisFreshness>();
  const analysisState = new Map<RepoPath, NonNullable<IndexedFileState["analysis"]>>();
  const cacheKeys: AnalysisCacheKey[] = [];
  const texts = new Map<RepoPath, string>();
  const changedFiles = new Set<RepoPath>(deleted);
  let analyzed = 0;
  let analysisReused = 0;
  try {
    for (const f of current) {
      if (f.path.startsWith(STATE_PREFIX)) continue;
      const analyzer = selection.analyzerFor(f.path);
      if (analyzer === undefined) {
        lang("file-only").files++;
        continue;
      }
      const language = analyzer.languages.length === 1 ? (analyzer.languages[0] as string) : analyzer.id;
      lang(language).files++;
      const prev = prevFiles.get(f.path);
      let freshness: AnalysisFreshness = analysisFreshnessOf(previous, prev, f, analyzer);
      const key: AnalysisCacheKey = { path: f.path, contentHash: f.contentHash, analyzer: analyzer.id, analyzerIdentity: analyzer.identity };
      const facts = { analyzerVersion: analyzer.version, callResolution: analyzer.callResolution, capabilities: analyzer.capabilities };
      const stateOf = (status: "ok" | "failed") => ({ analyzer: analyzer.id, version: analyzer.version, identity: analyzer.identity, status });
      const cached = freshness === "fresh" ? readCachedAnalysis(rootDir, key) : undefined;
      if (freshness === "fresh" && cached === undefined) freshness = "missing";
      analysisFreshness.set(f.path, freshness);
      if (cached !== undefined) {
        analysisReused++;
        lang(language).reused++;
        diagnostics.push(...cached.diagnostics);
        analyses.push({ analysis: cached.analysis, ...facts });
        analysisState.set(f.path, stateOf("ok"));
        cacheKeys.push(key);
        continue;
      }
      changedFiles.add(f.path);
      const content = fs.readFileSync(path.join(rootDir, f.path));
      analyzed++;
      const started = performance.now();
      const r = analyzer.analyze({ path: f.path, content });
      lang(language).parsed++;
      lang(language).parseMs += performance.now() - started;
      diagnostics.push(...r.diagnostics);
      if (r.value === undefined) {
        failedAnalyses.push(f.path);
        lang(language).failed++;
        analysisState.set(f.path, stateOf("failed"));
        continue;
      }
      analyses.push({ analysis: r.value, ...facts });
      analysisState.set(f.path, stateOf("ok"));
      texts.set(f.path, content.toString("utf8"));
      diagnostics.push(...writeCachedAnalysis(rootDir, key, { analysis: r.value, diagnostics: r.diagnostics }).map((d) => ({ ...d, severity: "warning" as const })));
      cacheKeys.push(key);
    }
  } finally {
    if (options.registry === undefined) registry.dispose();
  }

  // ---- Git: the history window is recomputed whole when HEAD moves ----
  const git = await openGitProvider(rootDir);
  diagnostics.push(...git.diagnostics);
  const repoState = git.value === undefined ? undefined : await git.value.repositoryState();
  diagnostics.push(...(repoState?.diagnostics ?? []));
  const gitState: GitRepositoryState | undefined = repoState?.value;
  let history: HistorySummary | undefined;
  let historyRecomputed = false;
  if (git.value !== undefined && gitState?.headOid !== undefined) {
    const kept = previous?.history;
    if (kept !== undefined && kept.headOid === gitState.headOid && kept.shallow === gitState.shallow) history = kept.summary;
    else {
      const commits = await git.value.listCommits({ maxCommits: window });
      diagnostics.push(...commits.diagnostics);
      history = commits.value === undefined ? undefined : summarizeHistory(commits.value, window);
      historyRecomputed = true;
    }
  }

  // ---- module resolution reuse (config scope, file set, versions) ----
  const indexedFiles = new Set(current.map((f) => f.path).filter((p) => !p.startsWith(STATE_PREFIX)));
  const resolver = createLanguageModuleResolver({ root: rootDir, indexedFiles });
  const signals = resolutionSignals(rootDir, changes, previous);
  const moduleFreshness = new Map<RepoPath, ModuleResolutionFreshness>();
  const previousResolution = new Map<RepoPath, FileResolution>();
  for (const a of analyses) {
    const p = a.analysis.path;
    const prev = prevFiles.get(p)?.resolution;
    if (prev !== undefined) previousResolution.set(p, prev);
    const freshness: ModuleResolutionFreshness = moduleFreshnessOf(p, prev, previous, resolver.version, changedFiles, signals);
    moduleFreshness.set(p, freshness);
  }
  for (const [p, f] of prevFiles) if (f.resolution !== undefined && !previousResolution.has(p)) changedFiles.add(p); // no longer analyzed
  const memo: ResolutionMemo | undefined = previous === undefined ? undefined : {
    previous: previousResolution,
    reusableModules: new Set([...moduleFreshness].filter(([, f]) => f === "fresh").map(([p]) => p)),
    changedFiles,
    callVersionChanged: previous.callResolutionVersion !== CALL_RESOLUTION_VERSION,
    configDiagnostics: new Map(Object.entries(previous.configs).flatMap(([p, c]) => (c.diagnostics === undefined ? [] : [[p as RepoPath, c.diagnostics] as const]))),
  };

  // ---- plan (the full builder) ----
  const plan = buildGraphPlan({
    truth, trace, files: current, analyses, failedAnalyses,
    sourceText: (p) => {
      const known = texts.get(p);
      if (known !== undefined) return known;
      try {
        return fs.readFileSync(path.join(rootDir, p), "utf8");
      } catch {
        return undefined;
      }
    },
    moduleResolver: resolver,
    git: { ...(gitState === undefined ? {} : { state: gitState }), ...(history === undefined ? {} : { history }) },
  }, memo);
  diagnostics.push(...plan.diagnostics);
  if (!plan.valid) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", "The graph plan did not pass validation; nothing was written"), ...diagnostics]);
  }

  // ---- new state ----
  const digests = scopeDigests(plan.nodes, plan.edges);
  const configFiles = [...new Set([...plan.resolution.values()].flatMap((r) => r.configFiles))].sort(compareUtf8);
  const configs: Record<string, { contentHash: string; diagnostics?: readonly Diagnostic[] }> = {};
  for (const c of configFiles) {
    const h = hashOnDisk(rootDir, c);
    const stored = plan.configDiagnostics.get(c);
    if (h !== undefined) configs[c] = { contentHash: h, ...(stored === undefined ? {} : { diagnostics: stored }) };
  }
  const files: IndexedFileState[] = current.map((f) => {
    const analysis = analysisState.get(f.path);
    const resolution = plan.resolution.get(f.path);
    const scope = digests.get(fileScope(f.path));
    return {
      path: f.path, state: f.state, fingerprintMode: f.fingerprintMode, contentHash: f.contentHash, size: f.size,
      ...(f.gitBlobOid === undefined ? {} : { gitBlobOid: f.gitBlobOid }),
      ...(analysis === undefined ? {} : { analysis }),
      ...(resolution === undefined ? {} : { resolution }),
      ...(scope === undefined ? {} : { scope }),
    };
  });
  const content: Omit<IndexState, "token"> = {
    format: INDEX_STATE_FORMAT, version: INDEX_STATE_VERSION,
    graphSchemaVersion: store.graphSchemaVersion,
    moduleResolutionVersion: resolver.version,
    callResolutionVersion: CALL_RESOLUTION_VERSION,
    analyzers: analyzerIdentities,
    analyzerRegistryDigest,
    historyWindow: window,
    files, configs,
    truthScope: digests.get(TRUTH_SCOPE) ?? EMPTY_DIGEST,
    ...(gitState?.headOid === undefined || history === undefined ? {} : { history: { headOid: gitState.headOid, shallow: gitState.shallow, summary: history } }),
    ...(gitState === undefined ? {} : {
      git: { ...(gitState.headOid === undefined ? {} : { headOid: gitState.headOid }), ...(gitState.branch === undefined ? {} : { branch: gitState.branch }), detached: gitState.detached },
    }),
    diagnostics: persistentDiagnostics(diagnostics),
  };
  const state: IndexState = { ...content, token: indexStateToken(content) };

  // ---- which scopes changed ----
  const before = new Map<string, string>();
  if (previous !== undefined) {
    before.set(TRUTH_SCOPE, previous.truthScope);
    for (const f of previous.files) if (f.scope !== undefined) before.set(fileScope(f.path), f.scope);
  }
  const after = new Map(digests);
  if (!after.has(TRUTH_SCOPE)) after.set(TRUTH_SCOPE, state.truthScope);
  const changedScopes = new Set([...new Set([...before.keys(), ...after.keys()])].filter((s) => before.get(s) !== after.get(s)));

  // ---- write: graph + token in one transaction, then the state file ----
  let revision = Number(store.readMeta(GRAPH_REVISION_KEY) ?? "0");
  if (!Number.isSafeInteger(revision)) revision = 0;
  const counts = store.counts();
  const unchanged = previous !== undefined && changedScopes.size === 0 && previous.token === state.token;
  let diff: GraphDiff | undefined;
  if (!unchanged) {
    try {
      store.transaction((tx) => {
        if (previous !== undefined) {
          // Another writer may have changed the graph since the state was read.
          if (tx.readMeta(INDEX_STATE_TOKEN_KEY) !== previous.token) throw new GraphStoreError("BUSY", "The graph changed since the index state was read; run again");
          diff = diffScopes(tx, changedScopes, plan);
          applyGraphDiff(tx, diff);
        } else {
          replaceGraph(tx, plan);
        }
        tx.writeMeta(INDEX_STATE_TOKEN_KEY, state.token);
        if (previous === undefined || graphChanged(diff)) tx.writeMeta(GRAPH_REVISION_KEY, String(revision + 1));
      });
    } catch (error) {
      const code = error instanceof GraphStoreError ? error.code : "INTERNAL";
      return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Graph update rolled back (${code}): ${(error as Error).message}`), ...diagnostics]);
    }
    if (previous === undefined || graphChanged(diff)) revision++;
    // After the commit. If this fails the token no longer matches and the next run rebuilds.
    diagnostics.push(...writeIndexState(rootDir, state).diagnostics.map((d) => ({ ...d, severity: "warning" as const })));
    diagnostics.push(...writeFingerprintFile(rootDir, current).diagnostics.map((d) => ({ ...d, severity: "warning" as const })));
    pruneAnalysisCache(rootDir, cacheKeys);
  }

  // ---- report ----
  const count = (status: string) => changes.filter((c) => c.status === status).length;
  const work = plan.resolutionWork;
  const metrics: IndexMetrics = {
    mode, ...(fullRebuildReason === undefined ? {} : { fullRebuildReason }),
    files: {
      total: current.length, unchanged: previous === undefined ? 0 : count("UNCHANGED"), changed: count("CHANGED"),
      added: previous === undefined ? current.length : count("ADDED"), deleted: count("DELETED"),
      analyzed, analysisReused, analysisFailed: failedAnalyses.length,
    },
    resolution: {
      filesModulesRecomputed: work.filesModulesRecomputed, modulesRecomputed: work.modulesRecomputed, modulesReused: work.modulesReused,
      filesCallsRecomputed: work.filesCallsRecomputed, callsRecomputed: work.callsRecomputed, callsReused: work.callsReused,
    },
    history: { recomputed: historyRecomputed, commits: history?.commitCount ?? 0 },
    languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => compareUtf8(a, b)).map(([k, v]) => [k, { ...v, parseMs: Math.round(v.parseMs) }])),
    graph: previous === undefined
      ? {
          scopes: after.size, scopesChanged: after.size, nodesAdded: plan.nodes.length, nodesRemoved: counts.nodes, nodesUpdated: 0,
          edgesAdded: plan.edges.length, edgesRemoved: counts.edges, edgesUpdated: 0, written: true,
        }
      : {
          scopes: after.size, scopesChanged: changedScopes.size,
          nodesAdded: diff?.nodesAdded ?? 0, nodesRemoved: diff?.nodesToDelete.length ?? 0, nodesUpdated: diff?.nodesUpdated ?? 0,
          edgesAdded: diff?.edgesAdded ?? 0, edgesRemoved: diff?.edgesToDelete.length ?? 0, edgesUpdated: diff?.edgesUpdated ?? 0,
          written: !unchanged,
        },
  };
  const freshness: FileFreshnessRecord[] = [...fileFreshness.keys()].sort(compareUtf8).map((p) => {
    const a = analysisFreshness.get(p);
    const m = moduleFreshness.get(p);
    const c = work.callFreshness.get(p);
    return {
      path: p, file: fileFreshness.get(p) ?? "unknown",
      ...(a === undefined ? {} : { analysis: a }), ...(m === undefined ? {} : { modules: m }), ...(c === undefined ? {} : { calls: c }),
    };
  });
  return success({ mode, ...(fullRebuildReason === undefined ? {} : { fullRebuildReason }), metrics, freshness, stats: plan.stats, graphRevision: revision }, canonicalDiagnostics(diagnostics));
}

function graphChanged(diff: GraphDiff | undefined): boolean {
  return diff !== undefined && (diff.nodesToUpsert.length + diff.nodesToDelete.length + diff.edgesToUpsert.length + diff.edgesToDelete.length) > 0;
}
