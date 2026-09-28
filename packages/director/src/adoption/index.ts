/** Existing Project Adoption (T14.1): working tree observation, Adoption Baseline capture and status, violation keys. */
export { captureAdoptionBaseline, getAdoptionBaselineStatus, loadAdoptionBaseline, type CaptureBaselineOptions } from "./baseline.js";
export { headBaselineFindings, type HeadFindingsInput } from "./head.js";
export { declaredReferenceParts, dependencyOffending, sourceOffending, violationKey } from "./key.js";
export { observeWorkingTree } from "./worktree.js";
export type * from "./types.js";
