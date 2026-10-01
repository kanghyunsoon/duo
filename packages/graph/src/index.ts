/**
 * @duo-director/graph — Project Graph storage (TASK-003), builder (TASK-007), incremental Indexer,
 * trace and impact (TASK-008).
 */
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export * from "./store/types.js";
export { openNodeSqliteGraphStore, type OpenNodeSqliteGraphStoreOptions } from "./store/node-sqlite/node-sqlite-graph-store.js";
export { GRAPH_SCHEMA_VERSION } from "./store/node-sqlite/schema.js";
export { traverse, type TraversalResult, type TraverseOptions } from "./traverse.js";
export { EDGE_ENDPOINTS, isEdgeEndpointAllowed } from "./build/endpoints.js";
export { NODE_PAYLOAD_SCHEMAS, payloadProblem, type NodePayload } from "./build/payload.js";
export type {
  ModuleResolution, ModuleResolutionRequest, ModuleResolutionStatus, ModuleResolver,
} from "./build/resolve/module-resolver.js";
export {
  createTypeScriptModuleResolver, TYPESCRIPT_MODULE_RESOLUTION_VERSION, TYPESCRIPT_VERSION, type TypeScriptModuleResolverOptions,
} from "./build/resolve/typescript/typescript-module-resolver.js";
export { MAX_REEXPORT_DEPTH } from "./build/exports.js";
export type {
  AnalyzedFile, CallResolution, CallResolutionFreshness, CallResolutionStatus, EdgeCategory, FileResolution, GraphBuildInput, GraphBuildPlan,
  GraphBuildStats, HistorySummary, ModuleResolutionRecord, ResolutionMemo, ResolutionWork, StoredCallOutcome,
} from "./build/types.js";
export { buildGraphPlan, CALL_RESOLUTION_VERSION } from "./build/builder.js";
export { applyGraphPlan, replaceGraph } from "./build/apply.js";
export { HISTORY_WINDOW, MAX_ISSUE_COMMITS, summarizeHistory } from "./build/history.js";
export { codeFileOf, edgeRow, edgeScope, nodeRow, nodeScope, scopeDigests, TRUTH_SCOPE } from "./build/scope.js";
export { collectGraphFacts, type CollectOptions } from "./build/collect.js";
export { checkGraph, dumpGraph, type GraphCheckOptions } from "./check.js";
export { GRAPH_DB_FILE_PATH, indexRepository, isResolutionConfigFile, openProjectGraphReader, openProjectGraphStore, type IndexOptions } from "./incremental/indexer.js";
export { inspectIndex, type AnalysisCoverage, type IndexInspection, type IndexStatus, type InspectFreshnessRecord, type InspectOptions } from "./incremental/inspect.js";
export {
  createLanguageModuleResolver, CPP_INCLUDE_RESOLUTION_VERSION, discoverPythonRoots, MODULE_RESOLUTION_VERSION, PYTHON_RESOLUTION_VERSION, resolveCppInclude, resolvePython,
  type LanguageResolverOptions, type PythonRoot, type PythonRootBasis, type PythonRoots,
} from "./build/resolve/languages.js";
export type { IndexedGraph } from "./incremental/assess.js";
export type {
  AnalysisFreshness, FileFreshness, FileFreshnessRecord, FullRebuildReason, IndexMetrics, IndexMode, IndexResult, ModuleResolutionFreshness,
} from "./incremental/types.js";
export {
  GRAPH_REVISION_KEY, INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, readIndexState, type IndexedFileState, type IndexState,
} from "./incremental/state.js";
export { ANALYSIS_CACHE_DIR } from "./incremental/analysis-cache.js";
export { applyGraphDiff, diffScopes, type GraphDiff } from "./incremental/diff.js";
export { impact, impactSeedsOfFiles, type ImpactItem, type ImpactOptions, type ImpactRelation, type ImpactResult } from "./query/impact.js";
export { trace, TRACE_EDGE_TYPES } from "./query/trace.js";
export { nodeLocations } from "./query/locations.js";
export {
  DECLARATION_LINKS_FORMAT, DECLARATION_LINKS_KEY, declarationLinks, readDeclarationLinks, type DeclarationEnd, type DeclarationLink,
} from "./build/declaration-links.js";

export const packageInfo: PackageInfo = {
  name: "@duo-director/graph",
  dependsOn: [analyzer.name, core.name],
};
