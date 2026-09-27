/**
 * @duo-director/graph — GraphStore, builder, traversal, incremental, trace, impact.
 * T01 skeleton only. Domain code starts in TASK-003 (docs/tasks/TASKS.md).
 */
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/graph",
  dependsOn: [analyzer.name, core.name],
};
