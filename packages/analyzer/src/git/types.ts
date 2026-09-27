/**
 * Git Provider domain model (TASK-006). Read-only facts about a repository: state, HEAD / index /
 * working-tree provenance, changes and diffs. No Git output format appears here. The provider does
 * not decide freshness, update the Graph or change the repository.
 */
import type { RepoPath } from "@duo-director/core";

export type GitObjectFormat = "sha1" | "sha256";

export interface GitRepositoryState {
  readonly objectFormat: GitObjectFormat;
  /** Commit HEAD points to; absent in an unborn repository (git init, no commit yet). */
  readonly headOid?: string;
  /** Short branch name. Absent when detached; the future branch name when unborn. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly unborn: boolean;
  /** History is truncated (shallow clone); co-change counts are then partial. */
  readonly shallow: boolean;
  /**
   * Repository identity: root commits reachable from HEAD, sorted. The same history has the same
   * identity in every clone and on every OS. Empty when unborn.
   */
  readonly rootCommitOids: readonly string[];
}

/**
 * Change kinds. "renamed" and "copied" come from Git's similarity heuristic; "untracked" appears
 * only on the unstaged axis; "unmerged" marks a conflict on both axes.
 */
export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "untracked" | "unmerged";

/**
 * One path in the working tree status. HEAD, index and working tree are three states: staged is
 * HEAD → index, unstaged is index → working tree. A path can have both.
 */
export interface GitWorkingTreeChange {
  readonly path: RepoPath;
  /** Rename/copy source (Git heuristic). Graph node IDs are not moved here; the Indexer decides. */
  readonly oldPath?: RepoPath;
  /** Git similarity score 0..100 of a rename/copy. A heuristic, not a fact. */
  readonly similarity?: number;
  readonly staged?: GitChangeKind;
  readonly unstaged?: GitChangeKind;
  /** Git conflict code (e.g. "UU", "AA") for unmerged paths. */
  readonly conflict?: string;
  /** A gitlink (submodule) entry. Its contents are not inspected. */
  readonly submodule: boolean;
  readonly headMode?: string;
  readonly indexMode?: string;
  readonly worktreeMode?: string;
  readonly headOid?: string;
  readonly indexOid?: string;
}

/** One path changed between two commits (or a commit and the index / working tree). */
export interface GitRangeChange {
  readonly path: RepoPath;
  readonly oldPath?: RepoPath;
  readonly similarity?: number;
  readonly kind: GitChangeKind;
  readonly submodule: boolean;
  readonly oldMode?: string;
  readonly newMode?: string;
  /** Absent for the working-tree side (not hashed by Git) and for added/deleted sides. */
  readonly oldOid?: string;
  readonly newOid?: string;
}

/** A diff endpoint. INDEX and WORKTREE are the staging area and the working tree. */
export type GitDiffEnd = "HEAD" | "INDEX" | "WORKTREE" | { readonly commit: string };

export interface GitDiffRequest {
  /** Older side. Supported pairs: HEAD→INDEX, INDEX→WORKTREE, HEAD→WORKTREE, commit→INDEX|WORKTREE|HEAD|commit, HEAD→commit. */
  readonly from: GitDiffEnd;
  readonly to: GitDiffEnd;
  /** Files to diff; required (no whole-repository diff). Include oldPath to see a rename. */
  readonly files: readonly { readonly path: RepoPath; readonly oldPath?: RepoPath }[];
  /** Context lines per hunk. Default 3. */
  readonly contextLines?: number;
}

export interface GitDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Text after the second "@@" (function context), may be empty. */
  readonly section: string;
  /** Hunk lines with their " ", "+", "-" or "\\" prefix, without the line break. */
  readonly lines: readonly string[];
}

export interface GitFileDiff extends GitRangeChange {
  /** Git considers the content binary; no hunks are produced. */
  readonly binary: boolean;
  /** Blob sizes in bytes, binary files only, when known. */
  readonly oldSize?: number;
  readonly newSize?: number;
  /** Empty for binary files, pure renames and mode-only changes. */
  readonly hunks: readonly GitDiffHunk[];
}

/** HEAD and index blob OIDs of a tracked path, kept apart (T04 gitBlobOid is the index one). */
export interface GitBlobProvenance {
  readonly path: RepoPath;
  readonly headBlobOid?: string;
  readonly indexBlobOid?: string;
}

export interface GitCommit {
  readonly oid: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** Files changed relative to the first parent (none listed for merge commits). */
  readonly files: readonly RepoPath[];
}

/** Where to read a blob from. */
export type GitBlobSource = "HEAD" | "INDEX" | { readonly commit: string };
