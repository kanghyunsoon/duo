import fs from "node:fs";
import path from "node:path";

export type AuditStatus = "통과" | "제품 문제" | "도구 오류" | "미검증";

export interface SerializedAuditError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedAuditError | string;
  readonly errors?: readonly (SerializedAuditError | string)[];
  readonly circular?: boolean;
  readonly truncated?: boolean;
}
export interface AuditRecord {
  readonly id: string;
  readonly status: AuditStatus;
  readonly findings?: readonly { readonly status: AuditStatus; readonly detail: string }[];
  readonly attempts?: readonly unknown[];
  readonly toolErrors?: readonly unknown[];
  readonly steps?: readonly unknown[];
  readonly blockedBy?: { readonly caseId: string; readonly reason: string };
  readonly [key: string]: unknown;
}

export interface AuditCleanupError { readonly phase: string; readonly error: SerializedAuditError }
export interface AuditAttemptFailure { readonly attemptIndex: number; readonly error: SerializedAuditError; readonly cleanupErrors?: readonly AuditCleanupError[] }
export interface AuditLifecycleResult<T> {
  readonly result?: T;
  readonly attempts: readonly AuditAttemptFailure[];
  readonly toolErrors: readonly AuditCleanupError[];
}

export interface AuditTableSnapshot {
  readonly role?: string | null;
  readonly complex: boolean;
  readonly headerIds: readonly string[];
  readonly cells: readonly { readonly headers: readonly string[]; readonly hasRowHeader: boolean; readonly hasColumnHeader: boolean }[];
}

export interface AuditTableAssessment {
  readonly kind: "data" | "presentation" | "complex";
  readonly reason: string;
  readonly missingHeaders: boolean;
}

export function assessTable(snapshot: AuditTableSnapshot): AuditTableAssessment {
  if (snapshot.role === "presentation" || snapshot.role === "none") {
    return { kind: "presentation", reason: `Explicit role=${snapshot.role}`, missingHeaders: false };
  }
  if (snapshot.complex) return { kind: "complex", reason: "Merged or multilevel associations need manual review", missingHeaders: false };
  const headerIds = new Set(snapshot.headerIds.filter(Boolean));
  const missingHeaders = snapshot.cells.some((cell) => cell.headers.length > 0
    ? cell.headers.some((id) => !headerIds.has(id))
    : !cell.hasRowHeader && !cell.hasColumnHeader);
  return { kind: "data", reason: "Simple native th and td associations", missingHeaders };
}

export function compareFocusSequence(expected: readonly string[], actual: readonly string[]): { readonly pass: boolean; readonly missing: readonly string[]; readonly unexpected: readonly string[]; readonly duplicated: readonly string[] } {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const item of expected) expectedCounts.set(item, (expectedCounts.get(item) ?? 0) + 1);
  for (const item of actual) actualCounts.set(item, (actualCounts.get(item) ?? 0) + 1);
  const missing = expected.filter((item) => (actualCounts.get(item) ?? 0) < (expectedCounts.get(item) ?? 0));
  const unexpected = actual.filter((item) => (expectedCounts.get(item) ?? 0) === 0);
  const duplicated = [...actualCounts].filter(([, count]) => count > 1).map(([item]) => item);
  const pass = expected.length === actual.length && expected.every((item, index) => item === actual[index]) && missing.length === 0 && unexpected.length === 0 && duplicated.length === 0;
  return { pass, missing, unexpected, duplicated };
}

export function hasUnverifiedFindings(record: Pick<AuditRecord, "findings">): boolean {
  return record.findings?.some((finding) => finding.status === "미검증") ?? false;
}

const MAX_DEPTH = 8;
const MAX_STACK = 16_384;
const MAX_MESSAGE = 4_096;
const MAX_AGGREGATE_ERRORS = 32;

function limited(value: string, max: number): { value: string; truncated: boolean } {
  return value.length > max ? { value: `${value.slice(0, max)}…`, truncated: true } : { value, truncated: false };
}

export function serializeAuditError(error: unknown): SerializedAuditError {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): SerializedAuditError | string => {
    if (!(value instanceof Error)) return String(value);
    if (seen.has(value)) return { name: value.name || "Error", message: "[circular error reference]", circular: true };
    if (depth >= MAX_DEPTH) return { name: value.name || "Error", message: "[maximum error depth reached]", truncated: true };
    seen.add(value);
    const message = limited(value.message, MAX_MESSAGE);
    const stack = value.stack === undefined ? undefined : limited(value.stack, MAX_STACK);
    const candidate = value as Error & { cause?: unknown; errors?: Iterable<unknown> };
    const cause = candidate.cause === undefined ? undefined : visit(candidate.cause, depth + 1);
    const children: (SerializedAuditError | string)[] | undefined = candidate.errors === undefined ? undefined : [];
    let aggregateTruncated = false;
    if (candidate.errors !== undefined && children !== undefined) {
      for (const child of candidate.errors) {
        if (children.length === MAX_AGGREGATE_ERRORS) { aggregateTruncated = true; break; }
        children.push(visit(child, depth + 1));
      }
    }
    return {
      name: value.name || "Error",
      message: message.value,
      ...(stack === undefined ? {} : { stack: stack.value }),
      ...(cause === undefined ? {} : { cause }),
      ...(children === undefined ? {} : { errors: children }),
      ...(message.truncated || stack?.truncated || aggregateTruncated ? { truncated: true } : {}),
    };
  };
  return typeof error === "object" && error !== null ? visit(error, 0) as SerializedAuditError : { name: "Error", message: String(error) };
}

/** Remove machine-specific and free-form diagnostic data before evidence is shared. */
export function sanitizeAuditArtifact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditArtifact);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "schemaVersion") { result.schemaVersion = 3; continue; }
    if (["cwd", "gitStatus", "stack", "cause", "errors"].includes(key)) continue;
    if (key === "message" && ("name" in record || "phase" in record)) continue;
    if (key === "error" && child !== null && typeof child === "object") {
      const error = child as Record<string, unknown>;
      result.error = { name: typeof error.name === "string" ? error.name : "Error", message: "[redacted]" };
      continue;
    }
    result[key] = sanitizeAuditArtifact(child);
  }
  return result;
}

export function assertNoPrivatePathsInEvidence(summaryPath: string, casesPath: string, repositoryRoot: string, homeDirectory: string): void {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const insensitive = (value: string) => /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
  const candidates = [repositoryRoot, homeDirectory].filter(Boolean).map((value) => ({
    value: normalize(value), ignoreCase: insensitive(value),
  }));
  const includesPath = (text: string, candidate: typeof candidates[number]): boolean => {
    const haystack = normalize(text);
    return candidate.ignoreCase
      ? haystack.toLocaleLowerCase("en-US").includes(candidate.value.toLocaleLowerCase("en-US"))
      : haystack.includes(candidate.value);
  };
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      if (candidates.some((candidate) => includesPath(value, candidate))) throw new Error("Private path found in shareable accessibility evidence");
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(inspect);
  };
  inspect(JSON.parse(fs.readFileSync(summaryPath, "utf8")));
  for (const line of fs.readFileSync(casesPath, "utf8").split(/\r?\n/u).filter(Boolean)) inspect(JSON.parse(line));
}

export async function runAuditLifecycle<T>(options: {
  readonly run: (attemptIndex: number) => Promise<T>;
  readonly cleanup: (attemptIndex: number) => Promise<readonly AuditCleanupError[]>;
  readonly onError?: (error: unknown, attemptIndex: number) => Promise<void> | void;
}): Promise<AuditLifecycleResult<T>> {
  const attempts: AuditAttemptFailure[] = [];
  const unresolvedToolErrors: AuditCleanupError[] = [];
  for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex++) {
    let result: T | undefined;
    try {
      result = await options.run(attemptIndex);
    } catch (error) {
      let errorHookFailures: readonly AuditCleanupError[] = [];
      try { await options.onError?.(error, attemptIndex); }
      catch (hookError) { errorHookFailures = [{ phase: "error-evidence", error: serializeAuditError(hookError) }]; }
      let cleanupErrors: readonly AuditCleanupError[];
      try { cleanupErrors = await options.cleanup(attemptIndex); }
      catch (cleanupError) { cleanupErrors = [{ phase: "cleanup", error: serializeAuditError(cleanupError) }]; }
      cleanupErrors = [...errorHookFailures, ...cleanupErrors];
      unresolvedToolErrors.push(...cleanupErrors);
      const serialized = serializeAuditError(error);
      attempts.push({ attemptIndex, error: serialized, ...(cleanupErrors.length === 0 ? {} : { cleanupErrors }) });
      if (attemptIndex === 2) return { attempts, toolErrors: [{ phase: "execution", error: serialized }, ...unresolvedToolErrors] };
      continue;
    }
    let cleanupErrors: readonly AuditCleanupError[];
    try { cleanupErrors = await options.cleanup(attemptIndex); }
    catch (cleanupError) { cleanupErrors = [{ phase: "cleanup", error: serializeAuditError(cleanupError) }]; }
    return { result, attempts, toolErrors: [...unresolvedToolErrors, ...cleanupErrors] };
  }
  return { attempts, toolErrors: [] };
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export function atomicWriteText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, text, { flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export function storeAuditRecord(directory: string, record: AuditRecord, existingIds: Set<string>): void {
  if (existingIds.has(record.id)) throw new Error(`Duplicate audit case ID: ${record.id}`);
  atomicWriteJson(path.join(directory, record.id.replaceAll(/[^\w.-]/gu, "_") , "result.json"), record);
  existingIds.add(record.id);
}

export function writeAuditSummary(filePath: string, value: unknown): void {
  atomicWriteJson(filePath, value);
}
