/**
 * Reviewed-snapshot contract (H-82, T67: C264). A verdict may exist only when its correctness inputs describe the
 * reviewed snapshot. The diff comes from the reviewed side, but the Project Graph index and Project Truth describe
 * the working tree. For --staged (INDEX) or --to <commit>, the review is decided only where the two are the same:
 * every changed path of the reviewed diff and every Project Truth file must be identical in the reviewed snapshot and
 * in the working tree, otherwise the Review fails without a verdict. Paths outside the diff that differ are reported
 * as a limitation, unless a rule read one of them to decide (H-103, #160: snapshot-inputs.ts); then the Review fails
 * the same way. Git computes the difference (its filters, untracked files); nothing is staged, checked out, stashed
 * or written.
 */
import type { GitDiffEnd, GitProvider } from "@duo-director/analyzer";
import { compareUtf8, createDiagnostic, failure, STATE_DIR_NAME, success, type Diagnostic, type ParseResult } from "@duo-director/core";
import type { Divergence } from "./snapshot-inputs.js";
import type { ChangedFile, ReviewLimitation } from "./types.js";

/** DUO's regenerable data and Review Records are not analysis inputs. */
const NOT_INPUT = ["generated/", "cache/", "runtime/", "reviews/"].map((d) => `${STATE_DIR_NAME}/${d}`);

export interface SnapshotCheck {
  /** Changed or Truth paths that differ between the reviewed snapshot and the working tree. */
  readonly mismatch: readonly string[];
  /** Other paths that differ (the index describes their working-tree content). */
  readonly outside: number;
  /** Those other paths and how they differ (H-103); empty for a working-tree review. */
  readonly divergent: ReadonlyMap<string, Divergence>;
}

export async function checkReviewedSnapshot(git: GitProvider, to: GitDiffEnd, files: readonly ChangedFile[]): Promise<ParseResult<SnapshotCheck>> {
  if (to === "WORKTREE") return success({ mismatch: [], outside: 0, divergent: new Map() });
  const tracked = await git.listChanges(to, "WORKTREE");
  if (tracked.value === undefined) return failure(tracked.diagnostics);
  const wt = await git.listWorkingTreeChanges();
  if (wt.value === undefined) return failure(wt.diagnostics);
  // "content": the path exists on both sides with other bytes; anything else changes whether it exists there.
  const divergent = new Map<string, Divergence>();
  for (const c of tracked.value) {
    if (c.submodule) continue;
    divergent.set(c.path, c.kind === "modified" && c.oldPath === undefined ? "content" : "existence");
    if (c.oldPath !== undefined) divergent.set(c.oldPath, "existence");
  }
  for (const c of wt.value) if (c.unstaged === "untracked" && !c.submodule) divergent.set(c.path, "existence");
  const reviewed = new Set<string>(files.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.path, f.oldPath])));
  const mismatch: string[] = [];
  const outside = new Map<string, Divergence>();
  for (const [p, kind] of [...divergent].sort((a, b) => compareUtf8(a[0], b[0]))) {
    if (NOT_INPUT.some((d) => p.startsWith(d))) continue;
    if (reviewed.has(p) || p.startsWith(`${STATE_DIR_NAME}/`)) mismatch.push(p);
    else outside.set(p, kind);
  }
  return success({ mismatch, outside: outside.size, divergent: outside }, [...tracked.diagnostics, ...wt.diagnostics]);
}

const preview = (paths: readonly string[]) => paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");

/** The failure: no verdict, the paths, and how a person can make the two sides match (DUO changes nothing). */
export function snapshotMismatch(to: GitDiffEnd, toLabel: string, paths: readonly string[]): Diagnostic {
  const side = to === "INDEX" ? "the staged snapshot (INDEX)" : `${toLabel}`;
  const fix = to === "INDEX"
    ? "Stage or stash the unstaged changes of these paths (for example git stash --keep-index), or review the working tree"
    : "Check out the reviewed commit (for example in a separate git worktree) and review there, or review the working tree";
  return createDiagnostic("REVIEW_SNAPSHOT_MISMATCH",
    `${paths.length} path(s) the review reads differ between ${side} and the working tree: ${preview(paths)}. DUO's index and Project Truth describe the working tree, so it gives no verdict for ${side}. ${fix}. DUO does not change the working tree.`);
}

export function outsideLimitation(toLabel: string, outside: number): ReviewLimitation[] {
  return outside === 0 ? [] : [{ code: "reviewed-side-context-from-working-tree", message: `${outside} file(s) outside the reviewed diff differ between ${toLabel} and the working tree; the index and Context describe their working-tree content.` }];
}

/** C265: a required analysis stage did not complete; there is no verdict (this is not an ASK). */
export function analysisIncomplete(stage: string, causes: readonly Diagnostic[]): Diagnostic {
  const why = causes.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`).join("; ");
  return createDiagnostic("REVIEW_ANALYSIS_INCOMPLETE",
    `The review could not complete its ${stage}${why === "" ? "" : ` (${why})`}. DUO gives no verdict on an incomplete review; this is not an ASK. For a large change, retry with a larger --budget or review fewer files with --files.`);
}
