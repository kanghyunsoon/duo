/**
 * Tracked changes in a Git working tree (#171): the porcelain lines of git status --untracked-files=no, empty when
 * the tree is clean. scripts/pack-cli.mjs records the result as pack.json "dirty" at pack time, and
 * scripts/ci/check-packed-artifact.mjs applies the same test at check time, so a tarball packed with a tracked edit
 * that was reverted afterwards is not reused as the build of that commit.
 */
import { execFileSync } from "node:child_process";

/** @param {string} root @returns {string[]} */
export function trackedChanges(root) {
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  return out === "" ? [] : out.split(/\r?\n/u);
}
