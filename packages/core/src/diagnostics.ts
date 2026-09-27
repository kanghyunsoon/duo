import { compareUtf8 } from "./order.js";

/**
 * Diagnostics are the core error model. Parsers and loaders collect them instead of throwing,
 * so one run reports every problem in a project: a parse failure is not a process crash.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * Repository-relative POSIX path with an optional 1-based range. Lines and columns are 1-based;
 * endColumn is exclusive (the column after the last character). Markdown and YAML use the same contract.
 */
export interface SourceLocation {
  readonly path: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/** Every diagnostic code with its default severity. */
export const DIAGNOSTIC_SEVERITY = {
  FILE_READ_ERROR: "error",
  FILE_WRITE_ERROR: "error",
  PROJECT_FILE_MISSING: "error",
  UNSUPPORTED_SCHEMA_VERSION: "error",
  MARKDOWN_PARSE_ERROR: "error",
  YAML_SYNTAX_ERROR: "error",
  YAML_WARNING: "warning",
  YAML_ALIAS_NOT_ALLOWED: "error",
  YAML_TAG_NOT_ALLOWED: "error",
  SCHEMA_UNKNOWN_PROPERTY: "error",
  SCHEMA_MISSING_PROPERTY: "error",
  SCHEMA_INVALID_VALUE: "error",
  INVALID_ID: "error",
  INVALID_PATH: "error",
  PATH_OUTSIDE_REPOSITORY: "error",
  /** Two paths that collide on case-insensitive or Unicode-normalizing file systems (scanner, T04). */
  PATH_PORTABILITY_COLLISION: "warning",
  WRITE_OUTSIDE_REPOSITORY: "error",
  WRITE_NOT_ALLOWED: "error",
  METADATA_BLOCK_WITHOUT_HEADING: "error",
  METADATA_BLOCK_MISSING: "warning",
  DUPLICATE_ID: "error",
  BROKEN_REFERENCE: "error",
  REFERENCE_TYPE_MISMATCH: "error",
  DECISION_SUPERSEDES_SELF: "error",
  DECISION_SUPERSEDE_CYCLE: "error",
  TRACE_MILESTONE_MISMATCH: "warning",
  TRACE_DECISION_UNRELATED: "warning",
  TRACE_REQUIREMENT_UNTRACKED: "info",
  GRAPH_SCHEMA_UNSUPPORTED: "error",
  GRAPH_OPEN_FAILED: "error",
  /** DUO MVP requires a Git repository (C36). duoctl init reports this for a non-Git directory (TASK-014). */
  GIT_REPOSITORY_REQUIRED: "error",
  /** Repository scan (T04). The scan root must be the top level of its Git work tree. */
  SCAN_ROOT_INVALID: "error",
  GIT_COMMAND_FAILED: "error",
  /** Git Provider (T06): a revision that does not name a commit. */
  GIT_REVISION_NOT_FOUND: "error",
  /** Git Provider: a request the provider does not support (for example a whole-repository diff). */
  GIT_REQUEST_INVALID: "error",
  /** Git Provider: Git printed output the parser does not understand. */
  GIT_OUTPUT_UNEXPECTED: "error",
  /** Git Provider: no blob for the path at the requested source. */
  GIT_OBJECT_NOT_FOUND: "error",
  /** A repository entry the scanner does not index: submodule, nested repository, non-portable name, not a regular file. */
  SCAN_ENTRY_SKIPPED: "info",
  /** A symlink inside the repository. Its target is never followed. */
  SYMLINK_SKIPPED: "info",
  /** A symlink whose target is outside the repository. The target is never read. */
  SYMLINK_OUTSIDE_REPOSITORY: "warning",
  /** The Git index and the working tree disagree on symlink vs regular file (T04.1). A fact for the Indexer. */
  FILE_TYPE_CHANGED: "info",
  /** generated/fingerprints.json is unreadable or has another format version; it is regenerated. */
  FINGERPRINT_CACHE_INVALID: "warning",
  /** LanguageAnalyzer (T05). A grammar or the Tree-sitter runtime could not be loaded (for example an ABI mismatch). */
  ANALYZER_INIT_FAILED: "error",
  /** No registered LanguageAnalyzer supports the file; it is not parsed. */
  LANGUAGE_UNSUPPORTED: "info",
  /** Source bytes are not valid UTF-8. */
  SOURCE_DECODE_ERROR: "error",
  /** The syntax tree contains ERROR or MISSING nodes; the analysis is partial. */
  AST_PARSE_ERROR: "warning",
  /** Parsing exceeded the per-file time limit (docs/10-security.md); no analysis. */
  AST_PARSE_TIMEOUT: "error",
  /** A "duo:" comment line that does not start with a definition ID. */
  DUO_ANNOTATION_INVALID: "warning",
  /** A test/suite call whose name is not a literal; it (and tests inside a suite) is not recorded (T05.1). */
  TEST_NAME_DYNAMIC: "info",
  /** Graph Builder (T07): a tsconfig.json / jsconfig.json that TypeScript reports as invalid. */
  TSCONFIG_INVALID: "warning",
  /** A relative import that resolves to no indexed repository file (likely a broken import). */
  MODULE_UNRESOLVED: "warning",
  /** A module reference with more than one candidate file. */
  MODULE_AMBIGUOUS: "warning",
  /** A call with more than one exact candidate target. Unresolved calls are counted in stats, not reported. */
  CALL_AMBIGUOUS: "info",
  /** Unresolved call sites (reported only as stats; kept for completeness of the model). */
  CALL_UNRESOLVED: "info",
  /** A "duo:" annotation ID that is not in Project Truth. */
  ANNOTATION_TARGET_UNKNOWN: "warning",
  /** A "duo:" annotation ID of a type that annotations cannot link (only Requirement IDs link). */
  ANNOTATION_TARGET_UNSUPPORTED: "info",
  /** An edge whose endpoint types are not allowed by 04 (a builder bug; the build is refused). */
  EDGE_ENDPOINT_INVALID: "error",
  /** Two facts produce the same Node ID with different content (the build is refused). */
  GRAPH_NODE_CONFLICT: "error",
  /** A node payload that does not match its schema (a builder bug; the build is refused). */
  GRAPH_PAYLOAD_INVALID: "error",
  /** applyGraphPlan() wrote nothing: the plan was invalid or the transaction rolled back. */
  GRAPH_WRITE_REFUSED: "error",
  /** Tests with the same fullName in one file: none of them becomes a Test Node. */
  TEST_ID_CONFLICT: "warning",
  /** A declared implements/governs symbol name that matches no symbol or more than one. */
  DECLARED_SYMBOL_UNRESOLVED: "warning",
  /** graph.check(): a consistency invariant (04) does not hold. */
  GRAPH_INVARIANT_VIOLATED: "error",
  /** Incremental Indexer (T08): generated/index-state.json is missing parts, corrupt or of another version; the graph is rebuilt. */
  INDEX_STATE_INVALID: "warning",
  /** DecisionService (T09): the actor may not perform the operation (only a human confirms or rejects). */
  DECISION_ACTOR_FORBIDDEN: "error",
  /** DecisionService: no proposal with this ID. */
  PROPOSAL_NOT_FOUND: "error",
  /** DecisionService: the proposal was already confirmed or rejected. */
  PROPOSAL_NOT_PENDING: "error",
  /** DecisionService: the proposal content does not pass the Project Truth schema or references. */
  PROPOSAL_INVALID: "error",
  /** DecisionService: Project Truth changed since the proposal was made (confirm still proceeds). */
  PROPOSAL_STALE: "warning",
  /** DecisionService: a confirmed Decision is not changed by DUO or an agent; supersede it instead. */
  DECISION_LOCKED: "error",
  /** DecisionService: the target is not a decisions/D-###.yaml file DUO writes (e.g. an ADR Markdown Decision). */
  DECISION_TARGET_UNSUPPORTED: "error",
  /** DecisionService: only a confirmed Decision can be superseded. */
  DECISION_SUPERSEDE_TARGET_INVALID: "error",
  /** DecisionService: another process holds the repository decision lock. */
  DECISION_LOCK_BUSY: "error",
  /** A confirmed Decision's lock.digest does not match its content fields (a detection aid, not a signature). */
  DECISION_LOCK_MISMATCH: "warning",
} as const satisfies Record<string, DiagnosticSeverity>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_SEVERITY;

/**
 * persistent: a deterministic function of the repository content, the Project Truth and the DUO
 * version. The same state yields the same persistent diagnostics, whether the result was computed
 * or reused from a cache (T08.1). transient: depends on the run (IO, locks, Git process failures,
 * local generated state) or reports the outcome of a requested operation; it is not a property of
 * the repository state and may differ between runs.
 */
export type DiagnosticPersistence = "persistent" | "transient";

const P = "persistent";
const T = "transient";

export const DIAGNOSTIC_PERSISTENCE = {
  FILE_READ_ERROR: T, FILE_WRITE_ERROR: T,
  PROJECT_FILE_MISSING: P, UNSUPPORTED_SCHEMA_VERSION: P,
  MARKDOWN_PARSE_ERROR: P, YAML_SYNTAX_ERROR: P, YAML_WARNING: P, YAML_ALIAS_NOT_ALLOWED: P, YAML_TAG_NOT_ALLOWED: P,
  SCHEMA_UNKNOWN_PROPERTY: P, SCHEMA_MISSING_PROPERTY: P, SCHEMA_INVALID_VALUE: P, INVALID_ID: P,
  INVALID_PATH: P, PATH_OUTSIDE_REPOSITORY: P, PATH_PORTABILITY_COLLISION: P,
  WRITE_OUTSIDE_REPOSITORY: T, WRITE_NOT_ALLOWED: T,
  METADATA_BLOCK_WITHOUT_HEADING: P, METADATA_BLOCK_MISSING: P,
  DUPLICATE_ID: P, BROKEN_REFERENCE: P, REFERENCE_TYPE_MISMATCH: P, DECISION_SUPERSEDES_SELF: P, DECISION_SUPERSEDE_CYCLE: P,
  TRACE_MILESTONE_MISMATCH: P, TRACE_DECISION_UNRELATED: P, TRACE_REQUIREMENT_UNTRACKED: P,
  GRAPH_SCHEMA_UNSUPPORTED: T, GRAPH_OPEN_FAILED: T,
  GIT_REPOSITORY_REQUIRED: P, SCAN_ROOT_INVALID: P,
  GIT_COMMAND_FAILED: T, GIT_REVISION_NOT_FOUND: T, GIT_REQUEST_INVALID: T, GIT_OUTPUT_UNEXPECTED: T, GIT_OBJECT_NOT_FOUND: T,
  SCAN_ENTRY_SKIPPED: P, SYMLINK_SKIPPED: P, SYMLINK_OUTSIDE_REPOSITORY: P, FILE_TYPE_CHANGED: P,
  FINGERPRINT_CACHE_INVALID: T,
  ANALYZER_INIT_FAILED: T, LANGUAGE_UNSUPPORTED: P, SOURCE_DECODE_ERROR: P, AST_PARSE_ERROR: P, AST_PARSE_TIMEOUT: T,
  DUO_ANNOTATION_INVALID: P, TEST_NAME_DYNAMIC: P,
  TSCONFIG_INVALID: P, MODULE_UNRESOLVED: P, MODULE_AMBIGUOUS: P, CALL_AMBIGUOUS: P, CALL_UNRESOLVED: P,
  ANNOTATION_TARGET_UNKNOWN: P, ANNOTATION_TARGET_UNSUPPORTED: P,
  EDGE_ENDPOINT_INVALID: P, GRAPH_NODE_CONFLICT: P, GRAPH_PAYLOAD_INVALID: P,
  GRAPH_WRITE_REFUSED: T, TEST_ID_CONFLICT: P, DECLARED_SYMBOL_UNRESOLVED: P, GRAPH_INVARIANT_VIOLATED: T,
  INDEX_STATE_INVALID: T,
  DECISION_ACTOR_FORBIDDEN: T, PROPOSAL_NOT_FOUND: T, PROPOSAL_NOT_PENDING: T, PROPOSAL_INVALID: T, PROPOSAL_STALE: T,
  DECISION_LOCKED: T, DECISION_TARGET_UNSUPPORTED: T, DECISION_SUPERSEDE_TARGET_INVALID: T, DECISION_LOCK_BUSY: T,
  DECISION_LOCK_MISMATCH: P,
} as const satisfies Record<DiagnosticCode, DiagnosticPersistence>;

export function isPersistentDiagnostic(diagnostic: Diagnostic): boolean {
  return DIAGNOSTIC_PERSISTENCE[diagnostic.code] === "persistent";
}

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: SourceLocation;
}

export interface ParseResult<T> {
  readonly value?: T;
  readonly diagnostics: readonly Diagnostic[];
}

export function createDiagnostic(code: DiagnosticCode, message: string, source?: SourceLocation): Diagnostic {
  const severity = DIAGNOSTIC_SEVERITY[code];
  return source === undefined ? { code, severity, message } : { code, severity, message, source };
}

export function withSeverity(diagnostic: Diagnostic, severity: DiagnosticSeverity): Diagnostic {
  return { ...diagnostic, severity };
}

/** Adds a location to a diagnostic that has none. */
export function withSource(diagnostic: Diagnostic, source: SourceLocation | undefined): Diagnostic {
  return diagnostic.source !== undefined || source === undefined ? diagnostic : { ...diagnostic, source };
}

export function success<T>(value: T, diagnostics: readonly Diagnostic[] = []): ParseResult<T> {
  return { value, diagnostics };
}

export function failure<T = never>(diagnostics: readonly Diagnostic[]): ParseResult<T> {
  return { diagnostics };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function formatLocation(source: SourceLocation): string {
  let text = source.path;
  if (source.startLine !== undefined) text += `:${source.startLine}`;
  if (source.startLine !== undefined && source.startColumn !== undefined) text += `:${source.startColumn}`;
  return text;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.source === undefined ? "<unknown>" : formatLocation(diagnostic.source);
  return `${where} ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}`;
}

/** Stable order: path, line, column, code. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const pa = a.source?.path ?? "";
  const pb = b.source?.path ?? "";
  if (pa !== pb) return compareUtf8(pa, pb);
  const la = a.source?.startLine ?? 0;
  const lb = b.source?.startLine ?? 0;
  if (la !== lb) return la - lb;
  const ca = a.source?.startColumn ?? 0;
  const cb = b.source?.startColumn ?? 0;
  if (ca !== cb) return ca - cb;
  return compareUtf8(a.code, b.code);
}

/** Full canonical order: location (path, start, end), code, severity, message. */
function compareCanonical(a: Diagnostic, b: Diagnostic): number {
  return compareDiagnostics(a, b)
    || (a.source?.endLine ?? 0) - (b.source?.endLine ?? 0)
    || (a.source?.endColumn ?? 0) - (b.source?.endColumn ?? 0)
    || compareUtf8(a.severity, b.severity)
    || compareUtf8(a.message, b.message);
}

/** Diagnostics in canonical order without exact duplicates. Two runs over the same state compare equal. */
export function canonicalDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const d of [...diagnostics].sort(compareCanonical)) {
    const s = d.source;
    const key = JSON.stringify([d.code, d.severity, d.message, s?.path, s?.startLine, s?.startColumn, s?.endLine, s?.endColumn]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** The persistent diagnostics of a run, canonical (T08.1 diagnostic equivalence). */
export function persistentDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return canonicalDiagnostics(diagnostics.filter(isPersistentDiagnostic));
}
