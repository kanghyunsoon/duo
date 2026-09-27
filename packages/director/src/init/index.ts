/** Init Service (TASK-014): planInit() is read-only; applyInitPlan() writes the planned Truth. Indexing is the caller's step. */
export { planInit, initPlanDigest, type PlanInitOptions } from "./plan.js";
export { applyInitPlan, normalizeInitAnswers, nodeInitFileSystem, type ApplyInitOptions, type InitFileSystem } from "./apply.js";
export { inspectStateDirectory, type StateInspection } from "./inspect.js";
export { INIT_DIRECTORIES, INIT_FILES, GITIGNORE_TEXT } from "./layout.js";
export type { DiscoveryOptions } from "./documents.js";
export type * from "./types.js";

