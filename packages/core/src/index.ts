/**
 * @duo-director/core — Core Data Contract: .duo-project schema, domain model, YAML/Markdown source parsing,
 * traceability, diagnostics and repository paths (TASK-002).
 */
export * from "./constants.js";
export * from "./diagnostics.js";
export * from "./llm-endpoint.js";
export * from "./evidence.js";
export * from "./ids.js";
export * from "./location.js";
export { readSourceFile, readSourceSlice } from "./source-file.js";
export * from "./order.js";
export * from "./paths.js";
export * from "./write-boundary.js";
export * from "./fs-guard.js";
export * from "./provenance.js";
export * from "./source/index.js";
export * from "./schema/schemas.js";
export { validateData } from "./schema/validate.js";
export * from "./domain/model.js";
export { parseDefinitionDocument, parseDefinitionMarkdown } from "./domain/definitions.js";
export { declaredGapId, normalizeGapText } from "./domain/gaps.js";
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
export {
  createDecisionService, DECISION_PERMISSIONS,
  type ConfirmPreview, type ConfirmResult, type DecisionService, type DecisionServiceOptions, type ProposalInput, type ProposeResult, type RejectResult, type StaleInfo,
} from "./decisions/service.js";
export {
  DECISION_LOCK_PATH, DECISIONS_DIR, decisionPath, guardDecisionWrite, nodeDecisionFileSystem, proposalPath, PROPOSALS_DIR,
  type ActorKind, type DecisionActor, type DecisionFileSystem, type DecisionWriteTarget,
} from "./decisions/files.js";
export { decisionLockDigest, definitionDigest, stableJson, truthDigest, verifyDecisionLock, type LockStatus, type LockVerification } from "./decisions/digest.js";
export { nextDecisionId, nextProposalId } from "./decisions/ids.js";
export {
  listDecisionProposals, pendingDecisionProposals, repairDecisionState, type DecisionProposalEntry, type ProposalStatus,
} from "./decisions/read-model.js";

/** Identity of a workspace package and the workspace packages it depends on at runtime. */
export interface PackageInfo {
  readonly name: string;
  readonly dependsOn: readonly string[];
}

export const packageInfo: PackageInfo = { name: "@duo-director/core", dependsOn: [] };
