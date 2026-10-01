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
  GitBlobProvenance, GitBlobSource, GitChangeKind, GitCommit, GitDiffEnd, GitDiffHunk, GitDiffRequest, GitFileDiff, GitObjectFormat,
  GitRangeChange, GitRepositoryState, GitWorkingTreeChange,
} from "./git/types.js";
export { openGitProvider, type GitProvider } from "./git/provider.js";
export { probeWorkTree, type WorkTreeProbe } from "./git/work-tree.js";
export { findGitTopLevel, readGitUserName } from "./git/identity.js";
export { computeCoChangeCandidates, extractIssueKeys, type CoChangeCandidate, type CoChangeOptions } from "./git/history.js";
export type {
  AnalysisLevel, AnalyzedSymbol, AnalyzedTest, AnalyzerCapabilities, CallResolutionStrategy, CallSite, CallSiteKind, DuoAnnotation, ImportBinding, LanguageAnalyzer, LocalExport,
  MemberScope, ModuleReference, ModuleReferenceKind, ModuleReferenceSyntax, ParseStatus, ReExportBinding, SourceAnalysis, SourceInput, SourceLanguage, SymbolKind,
  TestConfidence, TestFrameworkHint, TestKind, TestModifier,
} from "./language/types.js";
export { analysisLevelOf, CAPABILITY_CONTRACT_VERSION, CONTAINER_SYMBOL_KINDS, FILE_ONLY_CAPABILITIES } from "./language/types.js";
export {
  ANALYZER_SELECTION_VERSION, createAnalyzerRegistry, describeAnalyzers, headerContext, isCppHeader,
  type AnalyzerDescription, type AnalyzerRegistry, type AnalyzerSelection, type HeaderContext,
} from "./language/registry.js";
export {
  createDefaultAnalyzerRegistry, DEFAULT_EXTENSION_LANGUAGES, DEFAULT_LANGUAGE_PROFILES, languageProfile, type LanguageProfile,
} from "./language/default-registry.js";
export { parseDuoAnnotations } from "./language/annotations.js";
export { GRAMMAR_FILES, loadGrammarSet, type GrammarId, type GrammarLocator } from "./language/tree-sitter/runtime.js";
export { analyzerIdentity, createTreeSitterAnalyzer, type TreeSitterAnalyzerSpec } from "./language/tree-sitter/analyzer-base.js";
export {
  DEFAULT_PARSE_TIMEOUT_MS, JAVASCRIPT_EXTENSIONS, TS_JS_ANALYZER_VERSION, TS_JS_CAPABILITIES, TYPESCRIPT_EXTENSIONS,
  createJavaScriptAnalyzer, createTypeScriptAnalyzer, type TreeSitterAnalyzerOptions,
} from "./language/tree-sitter/ts-js-analyzer.js";
export {
  CPP_CAPABILITIES, CPP_SPEC, CSHARP_SPEC, JAVA_CSHARP_CAPABILITIES, JAVA_SPEC, PYTHON_CAPABILITIES, PYTHON_SPEC,
  createCppAnalyzer, createCSharpAnalyzer, createJavaAnalyzer, createPythonAnalyzer,
} from "./language/tree-sitter/languages.js";
export { maskCppAnnotationMacros } from "./language/tree-sitter/cpp-extract.js";
