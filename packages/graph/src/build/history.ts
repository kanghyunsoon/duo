/**
 * Git history facts for the Graph (04 CHANGED_WITH, Issue commit provenance). The window is always
 * the newest HISTORY_WINDOW commits of HEAD and is recomputed as a whole when HEAD moves (TASK-008,
 * H-25): counting only new commits would keep pairs whose commits left the window.
 */
import { createHash } from "node:crypto";
import { computeCoChangeCandidates, extractIssueKeys, type GitCommit } from "@duo-director/analyzer";
import { compareUtf8 } from "@duo-director/core";
import type { HistorySummary } from "./types.js";

/** Commits considered for CHANGED_WITH and Issue provenance (04). */
export const HISTORY_WINDOW = 500;
/** Commits kept as provenance per Issue key (newest first). */
export const MAX_ISSUE_COMMITS = 20;

/** Summarizes the newest window commits (commits are newest first, as GitProvider.listCommits returns them). */
export function summarizeHistory(commits: readonly GitCommit[], window: number = HISTORY_WINDOW): HistorySummary {
  const inWindow = commits.slice(0, window);
  const byKey = new Map<string, string[]>();
  for (const commit of inWindow) {
    for (const key of extractIssueKeys(commit.message)) {
      const list = byKey.get(key) ?? [];
      if (list.length < MAX_ISSUE_COMMITS && !list.includes(commit.oid)) list.push(commit.oid);
      byKey.set(key, list);
    }
  }
  const issueCommits = Object.fromEntries([...byKey.entries()].sort(([a], [b]) => compareUtf8(a, b)));
  return {
    commitCount: inWindow.length,
    windowFingerprint: `sha256:${createHash("sha256").update(inWindow.map((c) => c.oid).join("\n")).digest("hex")}`,
    coChange: computeCoChangeCandidates(inWindow),
    issueCommits,
  };
}
