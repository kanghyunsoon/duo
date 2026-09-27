/**
 * @duo-director/graph — Project Graph storage (TASK-003) and builder (TASK-007). Incremental update
 * and impact come in TASK-008.
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
export { createTypeScriptModuleResolver, TYPESCRIPT_VERSION, type TypeScriptModuleResolverOptions } from "./build/resolve/typescript/typescript-module-resolver.js";
export { MAX_REEXPORT_DEPTH } from "./build/exports.js";
export type {
  AnalyzedFile, CallResolution, CallResolutionStatus, GraphBuildInput, GraphBuildPlan, GraphBuildStats, ModuleResolutionRecord,
} from "./build/types.js";
export { buildGraphPlan } from "./build/builder.js";
export { applyGraphPlan } from "./build/apply.js";
export { collectGraphFacts, type CollectOptions } from "./build/collect.js";
export { checkGraph, type GraphCheckOptions } from "./check.js";

export const packageInfo: PackageInfo = {
  name: "@duo-director/graph",
  dependsOn: [analyzer.name, core.name],
};
