/**
 * Diagnostics are the core error model. Parsers and loaders collect them instead of throwing,
 * so one run reports every problem in a project: a parse failure is not a process crash.
 */
export type DiagnosticSeverity = "error" | "warning" | "info";

/** Repository-relative POSIX path with an optional 1-based line/column range. */
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
  METADATA_BLOCK_WITHOUT_HEADING: "error",
  METADATA_BLOCK_MISSING: "warning",
  DUPLICATE_ID: "error",
  BROKEN_REFERENCE: "error",
  REFERENCE_TYPE_MISMATCH: "error",
  TRACE_DECISION_UNRELATED: "warning",
  TRACE_REQUIREMENT_UNTRACKED: "info",
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
  if (pa !== pb) return pa < pb ? -1 : 1;
  const la = a.source?.startLine ?? 0;
  const lb = b.source?.startLine ?? 0;
  if (la !== lb) return la - lb;
  const ca = a.source?.startColumn ?? 0;
  const cb = b.source?.startColumn ?? 0;
  if (ca !== cb) return ca - cb;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}
