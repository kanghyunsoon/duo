/**
 * @duo-director/analyzer — repository file discovery and fingerprints (TASK-004). LanguageAnalyzer
 * (TASK-005) and GitEvidenceProvider (TASK-006) come later. Git CLI helpers stay internal.
 */
import { packageInfo as core, type PackageInfo } from "@duo-director/core";

export const packageInfo: PackageInfo = {
  name: "@duo-director/analyzer",
  dependsOn: [core.name],
};

export type {
  ExcludedFile, ExclusionReason, FileTypeChange, RepositoryEntryType, RepositoryFile, RepositoryFileState, RepositoryScan, ScanOptions,
} from "./scan/types.js";
export { scanRepository } from "./scan/scanner.js";
export { SECRET_FILE_PATTERNS, isSecretFileName } from "./scan/policy.js";
export { NORMALIZED_TEXT_EXTENSIONS, NORMALIZED_TEXT_FILE_NAMES, fingerprintModeOf, type FingerprintMode } from "./fingerprint/fingerprint-mode.js";
export { CONTENT_HASH_PREFIX, canonicalContent, computeContentHash, type ContentHash } from "./fingerprint/content-hash.js";
export {
  fingerprintRepositoryFiles, type FileFingerprint, type FingerprintOptions, type FingerprintResult,
} from "./fingerprint/fingerprint.js";
export {
  FINGERPRINT_FILE_PATH, FINGERPRINT_FORMAT, FINGERPRINT_FORMAT_VERSION,
  parseFingerprints, readFingerprintFile, serializeFingerprints, writeFingerprintFile,
} from "./fingerprint/store.js";
export { compareFingerprints, type FingerprintChange, type FingerprintChangeStatus } from "./fingerprint/compare.js";
export type {
  AnalyzedSymbol, AnalyzedTest, CallSite, CallSiteKind, DuoAnnotation, ImportBinding, LanguageAnalyzer, MemberScope, ModuleReference,
  ModuleReferenceKind, ParseStatus, ReExportBinding, SourceAnalysis, SourceInput, SourceLanguage, SymbolKind, TestConfidence,
  TestFrameworkHint, TestKind, TestModifier,
} from "./language/types.js";
export { createAnalyzerRegistry, type AnalyzerRegistry } from "./language/registry.js";
export { parseDuoAnnotations } from "./language/annotations.js";
export { GRAMMAR_FILES, type GrammarId, type GrammarLocator } from "./language/tree-sitter/runtime.js";
export {
  DEFAULT_PARSE_TIMEOUT_MS, JAVASCRIPT_EXTENSIONS, TS_JS_ANALYZER_VERSION, TYPESCRIPT_EXTENSIONS,
  createDefaultAnalyzerRegistry, createJavaScriptAnalyzer, createTypeScriptAnalyzer, type TreeSitterAnalyzerOptions,
} from "./language/tree-sitter/ts-js-analyzer.js";
