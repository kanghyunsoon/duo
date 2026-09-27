/**
 * @duo-director/graph — Project Graph storage (TASK-003). Builder, incremental update and impact
 * come in TASK-007/008.
 */
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export * from "./store/types.js";
export { openNodeSqliteGraphStore, type OpenNodeSqliteGraphStoreOptions } from "./store/node-sqlite/node-sqlite-graph-store.js";
export { GRAPH_SCHEMA_VERSION } from "./store/node-sqlite/schema.js";
export { traverse, type TraversalResult, type TraverseOptions } from "./traverse.js";

export const packageInfo: PackageInfo = {
  name: "@duo-director/graph",
  dependsOn: [analyzer.name, core.name],
};
