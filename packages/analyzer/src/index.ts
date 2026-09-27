/**
 * @duo-director/analyzer — repository file discovery and fingerprints (TASK-004). LanguageAnalyzer
 * (TASK-005) and GitEvidenceProvider (TASK-006) come later. Git CLI helpers stay internal.
 */
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/analyzer",
  dependsOn: [core.name],
};

export type { ExcludedFile, ExclusionReason, RepositoryFile, RepositoryFileState, RepositoryScan, ScanOptions } from "./scan/types.js";
export { scanRepository } from "./scan/scanner.js";
export { SECRET_FILE_PATTERNS, isSecretFileName } from "./scan/policy.js";
export { TEXT_FILE_EXTENSIONS, TEXT_FILE_NAMES, classifyContentKind, type FileContentKind } from "./fingerprint/content-kind.js";
export { CONTENT_HASH_PREFIX, canonicalContent, computeContentHash, type ContentHash } from "./fingerprint/content-hash.js";
export {
  fingerprintRepositoryFiles, type FileFingerprint, type FingerprintOptions, type FingerprintResult,
} from "./fingerprint/fingerprint.js";
export {
  FINGERPRINT_FILE_PATH, FINGERPRINT_FORMAT, FINGERPRINT_FORMAT_VERSION,
  parseFingerprints, readFingerprintFile, serializeFingerprints, writeFingerprintFile,
} from "./fingerprint/store.js";
export { compareFingerprints, type FingerprintChange, type FingerprintChangeStatus } from "./fingerprint/compare.js";
