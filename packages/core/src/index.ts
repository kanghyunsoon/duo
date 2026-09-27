/**
 * @duo/core — Core Data Contract: .duo schema, domain model, YAML/Markdown source parsing,
 * traceability, diagnostics and repository paths (TASK-002).
 */
export * from "./constants.js";
export * from "./diagnostics.js";
export * from "./ids.js";
export * from "./paths.js";
export * from "./source/index.js";
export * from "./schema/schemas.js";
export { validateData } from "./schema/validate.js";
export * from "./domain/model.js";
export { parseDefinitionDocument, parseDefinitionMarkdown } from "./domain/definitions.js";
export {
  parseConstraintsFile,
  parseDecisionFile,
  parseMilestoneFile,
  parseProjectConfig,
  parseProposalFile,
  parseVisionFile,
} from "./domain/files.js";
export * from "./trace/trace.js";
export { loadProjectTruth, type LoadedProject, type LoadProjectOptions } from "./loader/project.js";

/** Identity of a workspace package and the workspace packages it depends on at runtime. */
export interface PackageInfo {
  readonly name: string;
  readonly dependsOn: readonly string[];
}

export const packageInfo: PackageInfo = { name: "@duo/core", dependsOn: [] };
