import path from "node:path";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult } from "./diagnostics.js";

declare const repoPathBrand: unique symbol;

/**
 * Repository-relative path with POSIX separators. This is the only path form stored in
 * Project Truth, Evidence and node IDs, so the same file has the same ID on every OS.
 */
export type RepoPath = string & { readonly [repoPathBrand]: true };

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\/;

function isWindowsAbsolute(value: string): boolean {
  return WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value);
}

/** True for POSIX, Windows drive and UNC absolute paths, independent of the host OS. */
export function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || WINDOWS_DRIVE.test(value);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export interface NormalizePathOptions {
  /** Absolute repository root. When set, absolute inputs under it are made relative. */
  readonly root?: string;
}

/**
 * Canonicalizes a file path to a RepoPath: repository-relative, POSIX separators, dot segments
 * resolved. Nothing else: letter case, Unicode normalization (NFC/NFD) and surrounding spaces are
 * preserved exactly as Git and the file system spell them. Use findPathPortabilityCollisions()
 * to detect paths that would clash on case-insensitive or normalizing file systems.
 */
export function normalizeRepoPath(input: string, options: NormalizePathOptions = {}): ParseResult<RepoPath> {
  const raw = input;
  if (raw === "") return failure([createDiagnostic("INVALID_PATH", "Path is empty")]);
  let relative = raw;
  if (isAbsolutePathLike(raw)) {
    const root = options.root;
    if (root === undefined) {
      return failure([createDiagnostic("INVALID_PATH", `Absolute path "${raw}" is not allowed; use a repository-relative path`)]);
    }
    const windows = isWindowsAbsolute(raw) || isWindowsAbsolute(root);
    relative = windows ? path.win32.relative(root, raw) : path.posix.relative(toPosix(root), toPosix(raw));
    if (isAbsolutePathLike(relative)) {
      return failure([createDiagnostic("PATH_OUTSIDE_REPOSITORY", `Path "${raw}" is outside the repository`)]);
    }
  }
  const normalized = path.posix.normalize(toPosix(relative)).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return failure([createDiagnostic("INVALID_PATH", `Path "${raw}" points to the repository root`)]);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return failure([createDiagnostic("PATH_OUTSIDE_REPOSITORY", `Path "${raw}" is outside the repository`)]);
  }
  return success(normalized as RepoPath);
}

/**
 * Normalizes a repository glob pattern (for example "src\\auth\\**" to "src/auth/**").
 * Separators are converted; segments are kept. Absolute and ".." patterns are rejected.
 */
export function normalizeRepoPattern(input: string): ParseResult<string> {
  const raw = input;
  if (raw === "") return failure([createDiagnostic("INVALID_PATH", "Path pattern is empty")]);
  if (isAbsolutePathLike(raw)) {
    return failure([createDiagnostic("INVALID_PATH", `Absolute pattern "${raw}" is not allowed; use a repository-relative pattern`)]);
  }
  const posix = toPosix(raw).replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "");
  if (posix.split("/").includes("..")) {
    return failure([createDiagnostic("PATH_OUTSIDE_REPOSITORY", `Pattern "${raw}" leaves the repository`)]);
  }
  return success(posix);
}

/** Converts a host file path under root (for example from fs.readdir) to a RepoPath. */
export function toRepoPath(root: string, file: string): ParseResult<RepoPath> {
  return normalizeRepoPath(path.relative(root, file));
}

/**
 * Key under which two paths refer to the same file on a case-insensitive, Unicode-normalizing
 * file system (default Windows and macOS volumes). Used only for collision detection, never stored.
 */
export function portablePathKey(path: RepoPath): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * Reports groups of distinct paths that share a portablePathKey, e.g. "src/Auth.ts" and
 * "src/auth.ts", or NFC and NFD spellings of "café.ts". Deterministic order.
 */
export function findPathPortabilityCollisions(paths: readonly RepoPath[]): Diagnostic[] {
  const groups = new Map<string, Set<RepoPath>>();
  for (const p of paths) {
    const key = portablePathKey(p);
    const group = groups.get(key) ?? new Set<RepoPath>();
    group.add(p);
    groups.set(key, group);
  }
  const diagnostics: Diagnostic[] = [];
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    const spellings = [...group].sort();
    const reason = new Set(spellings.map((s) => s.normalize("NFC"))).size === 1
      ? "Unicode normalization"
      : new Set(spellings.map((s) => s.toLowerCase())).size === 1
        ? "letter case"
        : "letter case and Unicode normalization";
    diagnostics.push(createDiagnostic(
      "PATH_PORTABILITY_COLLISION",
      `Paths differ only by ${reason} and collide on case-insensitive file systems: ${spellings.join(", ")}`,
      { path: spellings[0] ?? "" },
    ));
  }
  return diagnostics.sort((a, b) => (a.source?.path ?? "").localeCompare(b.source?.path ?? ""));
}
