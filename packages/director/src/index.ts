/**
 * @duo-director/director — Context Compiler, Evidence, Review, Knowledge Gap, token budget, LLMProvider, init.
 * TASK-010: Context Compiler (context/) and the official token estimator (tokens/).
 */
import { packageInfo as graph } from "@duo-director/graph";
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export * from "./context/index.js";
export * from "./tokens/index.js";

export const packageInfo: PackageInfo = {
  name: "@duo-director/director",
  dependsOn: [graph.name, analyzer.name, core.name],
};
