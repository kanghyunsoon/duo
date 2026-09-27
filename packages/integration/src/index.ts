/**
 * @duo-director/integration — MCP, Codex/Claude adapters, local HTTP API.
 * T01 skeleton only. Domain code starts in TASK-016 (docs/tasks/TASKS.md).
 */
import { packageInfo as director } from "@duo-director/director";
import { packageInfo as graph } from "@duo-director/graph";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/integration",
  dependsOn: [director.name, graph.name, core.name],
};
