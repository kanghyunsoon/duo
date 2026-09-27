/**
 * @duo/integration — MCP, Codex/Claude adapters, local HTTP API.
 * T01 skeleton only. Domain code starts in TASK-016 (docs/tasks/TASKS.md).
 */
import { packageInfo as director } from "@duo/director";
import { packageInfo as graph } from "@duo/graph";
import { packageInfo as core, type PackageInfo } from "@duo/core";

export const packageInfo: PackageInfo = {
  name: "@duo/integration",
  dependsOn: [director.name, graph.name, core.name],
};
