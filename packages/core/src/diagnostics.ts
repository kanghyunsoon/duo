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
} as const satisfies Record<string, DiagnosticSeverity>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_SEVERITY;

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
