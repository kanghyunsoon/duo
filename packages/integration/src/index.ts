/**
 * @duo-director/integration — surfaces over the DUO services: shared operations and their structured
 * payloads (CLI and MCP, TASK-016), the duo-director MCP server. Codex/Claude adapters (TASK-017) and
 * the local HTTP API (TASK-018) come later.
 */
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as director } from "@duo-director/director";
import { packageInfo as graph } from "@duo-director/graph";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/integration",
  dependsOn: [director.name, graph.name, analyzer.name, core.name],
};

export * from "./operations/index.js";
export * from "./mcp/index.js";
export * from "./agents/index.js";
