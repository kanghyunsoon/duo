/**
 * FileFingerprint (TASK-004): what the Indexer compares between runs. mtime is not part of it;
 * content identity comes only from contentHash.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { compareDiagnostics, compareUtf8, createDiagnostic, type Diagnostic, type RepoPath } from "@duo-director/core";
import type { RepositoryFile, RepositoryFileState } from "../scan/types.js";
import { computeContentHash } from "./content-hash.js";
import { classifyContentKind, type FileContentKind } from "./content-kind.js";

export interface FileFingerprint {
  readonly path: RepoPath;
  readonly state: RepositoryFileState;
  readonly kind: FileContentKind;
  readonly contentHash: string;
  /** Bytes of the canonical content (text after CRLF → LF). */
  readonly size: number;
  /** Index blob OID, tracked files only. Provenance, never compared. */
  readonly gitBlobOid?: string;
}

export interface FingerprintResult {
  /** In UTF-8 byte order of path. */
  readonly fingerprints: readonly FileFingerprint[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface FingerprintOptions {
  /** Files read at the same time. Default 16. */
  readonly concurrency?: number;
}

async function fingerprintOne(root: string, file: RepositoryFile): Promise<FileFingerprint | Diagnostic> {
  const absolute = path.join(root, file.path);
  try {
    // The scanner already rejected symlinks; check again in case the entry changed since.
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) return createDiagnostic("SYMLINK_SKIPPED", `Symlink "${file.path}" is not followed`, { path: file.path });
    if (!stat.isFile()) return createDiagnostic("SCAN_ENTRY_SKIPPED", `"${file.path}" is not a regular file`, { path: file.path });
    const kind = classifyContentKind(file.path);
    const { contentHash, size } = computeContentHash(await fs.readFile(absolute), kind);
    const base = { path: file.path, state: file.state, kind, contentHash, size };
    return file.gitBlobOid === undefined ? base : { ...base, gitBlobOid: file.gitBlobOid };
  } catch (error) {
    return createDiagnostic("FILE_READ_ERROR", `Cannot read "${file.path}": ${(error as Error).message}`, { path: file.path });
  }
}

/** Computes fingerprints of scanned files. Unreadable files become diagnostics and are left out. */
export async function fingerprintRepositoryFiles(
  root: string,
  files: readonly RepositoryFile[],
  options: FingerprintOptions = {},
): Promise<FingerprintResult> {
  const rootDir = path.resolve(root);
  const results: (FileFingerprint | Diagnostic)[] = new Array<FileFingerprint | Diagnostic>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      if (file !== undefined) results[i] = await fingerprintOne(rootDir, file);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 16, files.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  const fingerprints: FileFingerprint[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const r of results) {
    if ("contentHash" in r) fingerprints.push(r);
    else diagnostics.push(r);
  }
  fingerprints.sort((a, b) => compareUtf8(a.path, b.path));
  return { fingerprints, diagnostics: diagnostics.sort(compareDiagnostics) };
}
