/**
 * Working tree observation (T14.1): staged, unstaged, untracked and conflicted paths from Git status,
 * outside .duo-project. A dirty tree is normal when DUO is installed into a project mid-development;
 * it is reported, never absorbed silently. Secret files are counted, not listed.
 */
import { isSecretFileName, type GitProvider } from "@duo-director/analyzer";
import { compareUtf8, failure, STATE_DIR_NAME, success, type ParseResult, type RepoPath } from "@duo-director/core";
import type { WorkingTreeObservation } from "./types.js";

export async function observeWorkingTree(git: GitProvider, cap = 1000): Promise<ParseResult<WorkingTreeObservation>> {
  const changes = await git.listWorkingTreeChanges();
  if (changes.value === undefined) return failure(changes.diagnostics);
  const staged: RepoPath[] = [];
  const unstaged: RepoPath[] = [];
  const untracked: RepoPath[] = [];
  const conflicted: RepoPath[] = [];
  let excludedSecrets = 0;
  for (const c of changes.value) {
    if (c.path === STATE_DIR_NAME || c.path.startsWith(`${STATE_DIR_NAME}/`)) continue;
    if (isSecretFileName(c.path)) { excludedSecrets++; continue; }
    if (c.conflict !== undefined || c.staged === "unmerged" || c.unstaged === "unmerged") { conflicted.push(c.path); continue; }
    if (c.unstaged === "untracked") { untracked.push(c.path); continue; }
    if (c.staged !== undefined) staged.push(c.path);
    if (c.unstaged !== undefined) unstaged.push(c.path);
  }
  const lists = [staged, unstaged, untracked, conflicted].map((l) => l.sort(compareUtf8));
  const counts = { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length, conflicted: conflicted.length };
  const [s, u, n, c] = lists.map((l) => l.slice(0, cap)) as [RepoPath[], RepoPath[], RepoPath[], RepoPath[]];
  return success({
    dirty: counts.staged + counts.unstaged + counts.untracked + counts.conflicted > 0,
    staged: s, unstaged: u, untracked: n, conflicted: c, counts, excludedSecrets, truncated: lists.some((l) => l.length > cap),
  });
}
