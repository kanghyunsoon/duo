/**
 * @duo/graph — GraphStore, builder, traversal, incremental, trace, impact.
 * T01 skeleton only. Domain code starts in TASK-003 (docs/tasks/TASKS.md).
 */
import { packageInfo as analyzer } from "@duo/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo/core";

export const packageInfo: PackageInfo = {
  name: "@duo/graph",
  dependsOn: [analyzer.name, core.name],
};
