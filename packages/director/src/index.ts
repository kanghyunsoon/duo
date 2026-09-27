/**
 * @duo-director/director — Context Compiler, Evidence, Review, Knowledge Gap, token budget, LLMProvider, init.
 * T01 skeleton only. Domain code starts in TASK-010 (docs/tasks/TASKS.md).
 */
import { packageInfo as graph } from "@duo-director/graph";
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/director",
  dependsOn: [graph.name, analyzer.name, core.name],
};
