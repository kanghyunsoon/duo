/**
 * History primitives (TASK-006, AC-006-03/04). Pure functions over GitCommit lists; the Graph
 * Builder turns them into CHANGED_WITH edges and Issue links.
 */
import { compareUtf8, isDefinitionId, type RepoPath } from "@duo-director/core";
import type { GitCommit } from "./types.js";

export interface CoChangeOptions {
  /** Minimum number of commits in which both files changed. Default 3 (04). */
  readonly minCount?: number;
  /** Commits touching more files are ignored. Default 50 (04). */
  readonly maxFilesPerCommit?: number;
}

export interface CoChangeCandidate {
  /** a < b in UTF-8 order; the Graph Builder stores both directions. */
  readonly a: RepoPath;
  readonly b: RepoPath;
  readonly count: number;
}

/**
 * CHANGED_WITH candidates (04): pairs of files changed together in at least minCount of the given
 * commits (the caller passes the most recent 500), ignoring commits with more than maxFilesPerCommit files.
 */
export function computeCoChangeCandidates(commits: readonly GitCommit[], options: CoChangeOptions = {}): CoChangeCandidate[] {
  const minCount = options.minCount ?? 3;
  const maxFiles = options.maxFilesPerCommit ?? 50;
  const counts = new Map<string, { a: RepoPath; b: RepoPath; count: number }>();
  for (const commit of commits) {
    const files = [...new Set(commit.files)].sort(compareUtf8);
    if (files.length < 2 || files.length > maxFiles) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i] as RepoPath;
        const b = files[j] as RepoPath;
        const key = `${a}\u0000${b}`;
        const entry = counts.get(key) ?? { a, b, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    }
  }
  return [...counts.values()].filter((c) => c.count >= minCount).sort((x, y) => compareUtf8(x.a, y.a) || compareUtf8(x.b, y.b));
}

const KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?(?![A-Za-z0-9])/gu;

/**
 * Issue key candidates in a commit message or branch name ("GAME-42", "feature/AUTH-03-login"),
 * in order of first appearance. Candidates only: the Graph Builder checks them against Project Truth
 * (so text like "UTF-8" is a candidate that matches nothing).
 */
export function extractIssueKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(KEY)) if (isDefinitionId(m[0]) && !keys.includes(m[0])) keys.push(m[0]);
  return keys;
}
