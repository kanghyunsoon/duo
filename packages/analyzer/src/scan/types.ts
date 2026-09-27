/**
 * Scanner contract (TASK-004). The scanner's own output, independent of GraphNode payloads
 * (those are defined by the Graph Builder, TASK-007). Git details stay inside the scanner.
 */
import type { Diagnostic, RepoPath } from "@duo-director/core";

/** Whether Git tracks the file (index entry) or it is an untracked, non-ignored file. */
export type RepositoryFileState = "tracked" | "untracked";

/** A file the scanner selected for indexing. */
export interface RepositoryFile {
  /** Tracked: Git index spelling. Untracked: file system spelling as Git reports it. */
  readonly path: RepoPath;
  readonly state: RepositoryFileState;
  /**
   * Git blob OID of the index entry (tracked files only, absent for merge conflicts).
   * Provenance only: it describes the index, not necessarily the working tree, and is never
   * used as the working-tree fingerprint (that is contentHash).
   */
  readonly gitBlobOid?: string;
}

/**
 * Why a repository entry is not indexed. Ignored files (.gitignore) and .git/ are not listed at
 * all: Git does not report them.
 */
export type ExclusionReason =
  /** A path segment named .git (defensive; Git never lists these). */
  | "git-internal"
  /** .duo-project/generated|cache|runtime: DUO's own regenerable data. */
  | "duo-regenerable"
  /** Matches SECRET_FILE_PATTERNS (docs/10-security.md). Checked before include/exclude. */
  | "secret"
  /** Matches project.yaml index.exclude. */
  | "index-exclude"
  /** index.include is set and the path matches none of it. */
  | "not-included"
  /** A symlink, or a path below a symlinked directory. The target is never followed. */
  | "symlink"
  /** Tracked, but not present in the working tree. */
  | "missing"
  /** Submodule (gitlink) or nested Git repository. */
  | "nested-repository"
  /** A directory, device or other entry where Git expects a file, or a name that is not a portable RepoPath. */
  | "unsupported-entry";

export interface ExcludedFile {
  readonly path: RepoPath;
  readonly state: RepositoryFileState;
  readonly reason: ExclusionReason;
}

export interface ScanOptions {
  /** project.yaml index.include. Empty or absent: every tracked and untracked file. */
  readonly include?: readonly string[];
  /** project.yaml index.exclude. */
  readonly exclude?: readonly string[];
}

export interface RepositoryScan {
  /** Files to index, in UTF-8 byte order of path. */
  readonly files: readonly RepositoryFile[];
  /** Entries Git reported that are not indexed, in UTF-8 byte order of path. */
  readonly excluded: readonly ExcludedFile[];
  /** Tracked entries whose working-tree type differs from the index, in UTF-8 byte order of path. */
  readonly typeChanges: readonly FileTypeChange[];
  readonly diagnostics: readonly Diagnostic[];
}

export type RepositoryEntryType = "regular-file" | "symlink";

/**
 * A fact for the Indexer (FILE_TYPE_CHANGED): the index records one type, the working tree has
 * another. The scanner does not decide freshness. A working-tree symlink stays excluded and its
 * target is not read; a working-tree regular file that replaced an index symlink is indexed as a
 * file, without gitBlobOid (the index blob is the old link text).
 */
export interface FileTypeChange {
  readonly path: RepoPath;
  readonly index: RepositoryEntryType;
  readonly workingTree: RepositoryEntryType;
}
