/**
 * Fingerprint cache: .duo-project/generated/fingerprints.json (TASK-004, ADR-006 Regenerable).
 * Kept out of graph.db so the Graph schema and the scan cache have separate lifecycles. The file is
 * deterministic (no timestamps, fixed key order, UTF-8 path order), and an unreadable or outdated
 * file is treated as empty: it is regenerable.
 */
import fs from "node:fs";
import path from "node:path";
import {
  checkWriteBoundary, compareUtf8, createDiagnostic, failure, normalizeRepoPath, STATE_DIR_NAME, success,
  type ParseResult, type RepoPath,
} from "@duo-director/core";
import type { FileFingerprint } from "./fingerprint.js";

export const FINGERPRINT_FILE_PATH = `${STATE_DIR_NAME}/generated/fingerprints.json` as RepoPath;
export const FINGERPRINT_FORMAT = "duo-fingerprints";
/** Bump when the file layout, the hash rules or the normalized-text lists change. 2: kind → fingerprintMode (T04.1). */
export const FINGERPRINT_FORMAT_VERSION = 2;

const ENTRY_KEYS = new Set(["path", "state", "fingerprintMode", "contentHash", "size", "gitBlobOid"]);
const HASH = /^sha256:[0-9a-f]{64}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Deterministic JSON text: 2-space indent, trailing newline, entries in UTF-8 path order. */
export function serializeFingerprints(fingerprints: readonly FileFingerprint[]): string {
  const files = [...fingerprints]
    .sort((a, b) => compareUtf8(a.path, b.path))
    .map((f) => {
      const entry = { path: f.path, state: f.state, fingerprintMode: f.fingerprintMode, contentHash: f.contentHash, size: f.size };
      return f.gitBlobOid === undefined ? entry : { ...entry, gitBlobOid: f.gitBlobOid };
    });
  return `${JSON.stringify({ format: FINGERPRINT_FORMAT, version: FINGERPRINT_FORMAT_VERSION, files }, null, 2)}\n`;
}

function invalid(reason: string): ParseResult<FileFingerprint[]> {
  return failure([
    createDiagnostic("FINGERPRINT_CACHE_INVALID", `${FINGERPRINT_FILE_PATH} is not usable (${reason}); it will be regenerated`, { path: FINGERPRINT_FILE_PATH }),
  ]);
}

function parseEntry(value: unknown): FileFingerprint | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "entry is not an object";
  const e = value as Record<string, unknown>;
  const extra = Object.keys(e).find((k) => !ENTRY_KEYS.has(k));
  if (extra !== undefined) return `unknown key "${extra}"`;
  const p = typeof e.path === "string" ? normalizeRepoPath(e.path).value : undefined;
  if (p === undefined || p !== e.path) return `invalid path ${JSON.stringify(e.path)}`;
  if (e.state !== "tracked" && e.state !== "untracked") return `invalid state for ${p}`;
  if (e.fingerprintMode !== "normalized-text" && e.fingerprintMode !== "raw") return `invalid fingerprintMode for ${p}`;
  if (typeof e.contentHash !== "string" || !HASH.test(e.contentHash)) return `invalid contentHash for ${p}`;
  if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0) return `invalid size for ${p}`;
  if (e.gitBlobOid !== undefined && (typeof e.gitBlobOid !== "string" || !OID.test(e.gitBlobOid))) return `invalid gitBlobOid for ${p}`;
  const base = { path: p, state: e.state, fingerprintMode: e.fingerprintMode, contentHash: e.contentHash, size: e.size } as const;
  return e.gitBlobOid === undefined ? base : { ...base, gitBlobOid: e.gitBlobOid };
}

/** Parses fingerprints.json text. Any problem yields FINGERPRINT_CACHE_INVALID and no value. */
export function parseFingerprints(text: string): ParseResult<FileFingerprint[]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return invalid("not JSON");
  }
  if (typeof data !== "object" || data === null) return invalid("not an object");
  const doc = data as Record<string, unknown>;
  if (doc.format !== FINGERPRINT_FORMAT) return invalid("unknown format");
  if (doc.version !== FINGERPRINT_FORMAT_VERSION) return invalid(`version ${JSON.stringify(doc.version)}, expected ${FINGERPRINT_FORMAT_VERSION}`);
  if (!Array.isArray(doc.files)) return invalid("files is not a list");
  const out: FileFingerprint[] = [];
  const seen = new Set<string>();
  for (const value of doc.files) {
    const entry = parseEntry(value);
    if (typeof entry === "string") return invalid(entry);
    if (seen.has(entry.path)) return invalid(`duplicate path ${entry.path}`);
    seen.add(entry.path);
    out.push(entry);
  }
  return success(out.sort((a, b) => compareUtf8(a.path, b.path)));
}

/** A symlink anywhere between root and the target would redirect the read or write. */
function symlinkOnPath(root: string, repoPath: RepoPath): string | undefined {
  const segments = repoPath.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const partial = segments.slice(0, i).join("/");
    try {
      if (fs.lstatSync(path.join(root, partial)).isSymbolicLink()) return partial;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asEmpty(result: ParseResult<FileFingerprint[]>): ParseResult<FileFingerprint[]> {
  return success([], result.diagnostics);
}

/**
 * Reads the previous fingerprints. A missing file is an empty cache (first scan). An invalid
 * file is also treated as empty, with a FINGERPRINT_CACHE_INVALID warning.
 */
export function readFingerprintFile(root: string): ParseResult<FileFingerprint[]> {
  const rootDir = path.resolve(root);
  if (symlinkOnPath(rootDir, FINGERPRINT_FILE_PATH) !== undefined) return asEmpty(invalid("the path contains a symlink"));
  let text: string;
  try {
    text = fs.readFileSync(path.join(rootDir, FINGERPRINT_FILE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success([]);
    return asEmpty(invalid((error as Error).message));
  }
  const parsed = parseFingerprints(text);
  return parsed.value === undefined ? asEmpty(parsed) : parsed;
}

/**
 * Writes fingerprints.json through the write boundary (regenerable area) with an atomic
 * temp-file-and-rename. Refuses when a symlink sits on the path.
 */
export function writeFingerprintFile(root: string, fingerprints: readonly FileFingerprint[]): ParseResult<RepoPath> {
  const rootDir = path.resolve(root);
  const allowed = checkWriteBoundary(rootDir, FINGERPRINT_FILE_PATH, "regenerable");
  if (allowed.value === undefined) return failure(allowed.diagnostics);
  const target = allowed.value.path;
  const link = symlinkOnPath(rootDir, target);
  if (link !== undefined) {
    return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${target}": "${link}" is a symlink`, { path: target })]);
  }
  const absolute = path.join(rootDir, target);
  const temp = `${absolute}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(temp, serializeFingerprints(fingerprints), "utf8");
    fs.renameSync(temp, absolute);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return failure([createDiagnostic("FILE_WRITE_ERROR", `Cannot write "${target}": ${(error as Error).message}`, { path: target })]);
  }
  return success(target);
}
