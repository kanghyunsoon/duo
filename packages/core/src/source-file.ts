/**
 * Reading repository source for slicing (T09.1): Decision digests, Packet Dependency Digest,
 * Evidence and source navigation all read a location's text here. The path must stay inside the
 * repository and no symlink may sit on it (the scanner never follows symlinks either). The text is
 * the canonical source text every SourceLocation addresses.
 */
import fs from "node:fs";
import path from "node:path";
import { createDiagnostic, failure, success, type ParseResult, type SourceLocation } from "./diagnostics.js";
import { canonicalSourceText, sliceSource } from "./location.js";
import { symlinkOnPath } from "./fs-guard.js";
import { normalizeRepoPath } from "./paths.js";

/** Canonical source text of a repository file. */
export function readSourceFile(root: string, repoPath: string): ParseResult<string> {
  const normalized = normalizeRepoPath(repoPath, { root });
  if (normalized.value === undefined) return failure(normalized.diagnostics);
  const p = normalized.value;
  const link = symlinkOnPath(root, p);
  if (link !== undefined) return failure([createDiagnostic("INVALID_PATH", `"${p}": "${link}" is a symlink and is not followed`, { path: p })]);
  try {
    return success(canonicalSourceText(fs.readFileSync(path.join(root, p), "utf8")));
  } catch (error) {
    return failure([createDiagnostic("FILE_READ_ERROR", `Cannot read "${p}": ${(error as Error).message}`, { path: p })]);
  }
}

/** The exact text of a location, read from the repository. */
export function readSourceSlice(root: string, location: SourceLocation): ParseResult<string> {
  const text = readSourceFile(root, location.path);
  return text.value === undefined ? failure(text.diagnostics) : sliceSource(text.value, location);
}

