/**
 * Diff collection (TASK-013). The caller names both endpoints; nothing is assumed. Tracked changes
 * come from the Git provider (zero context lines, so hunks are exactly the changed lines); on the
 * working-tree side untracked files count as added with one all-new hunk. DUO's regenerable data
 * (.duo-project/generated|cache|runtime/) is never reviewed; Human-owned Truth files are.
 *
 * Diff identity: endpoints (HEAD resolved to its commit) and, per path, change kind, blob IDs and
 * hunk content hashes. No mtime, no time of day.
 */
import type { GitDiffEnd, GitProvider } from "@duo-director/analyzer";
import { compareUtf8, readSourceFile, sha256Text, stableJson, STATE_DIR_NAME, type Diagnostic, type ParseResult, type RepoPath } from "@duo-director/core";
import { changeEvidence, hunkEvidence } from "../evidence/sources.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { ChangedFile, ChangedHunk } from "./types.js";

const EXCLUDED = ["generated/", "cache/", "runtime/"].map((d) => `${STATE_DIR_NAME}/${d}`);

export function endLabel(end: GitDiffEnd, headOid: string | undefined): string {
  if (end === "HEAD") return headOid ?? "HEAD";
  return typeof end === "string" ? end : end.commit;
}

export interface CollectedDiff {
  readonly files: readonly ChangedFile[];
  readonly identity: string;
  readonly from: string;
  readonly to: string;
  readonly diagnostics: readonly Diagnostic[];
}

export async function collectDiff(git: GitProvider, root: string, request: { readonly from: GitDiffEnd; readonly to: GitDiffEnd; readonly files?: readonly RepoPath[] }, store: EvidenceStore): Promise<ParseResult<CollectedDiff>> {
  const diagnostics: Diagnostic[] = [];
  const state = await git.repositoryState();
  if (state.value === undefined) return { diagnostics: state.diagnostics };
  const from = endLabel(request.from, state.value.headOid);
  const to = endLabel(request.to, state.value.headOid);
  const listed = await git.listChanges(request.from, request.to);
  diagnostics.push(...listed.diagnostics);
  if (listed.value === undefined) return { diagnostics };
  const only = request.files === undefined ? undefined : new Set<string>(request.files);
  const wanted = (p: string, old?: string) => !EXCLUDED.some((d) => p.startsWith(d)) && (only === undefined || only.has(p) || (old !== undefined && only.has(old)));
  const tracked = listed.value.filter((c) => c.kind !== "unmerged" && !c.submodule && wanted(c.path, c.oldPath));
  let untracked: RepoPath[] = [];
  if (request.to === "WORKTREE") {
    const wt = await git.listWorkingTreeChanges();
    diagnostics.push(...wt.diagnostics);
    untracked = (wt.value ?? []).filter((c) => c.unstaged === "untracked" && !c.submodule && wanted(c.path)).map((c) => c.path);
  }
  const files: ChangedFile[] = [];
  if (tracked.length > 0) {
    const diffs = await git.getDiff({ from: request.from, to: request.to, files: tracked.map((c) => ({ path: c.path, ...(c.oldPath === undefined ? {} : { oldPath: c.oldPath }) })), contextLines: 0 });
    diagnostics.push(...diffs.diagnostics);
    if (diffs.value === undefined) return { diagnostics };
    for (const d of diffs.value) {
      if (!wanted(d.path, d.oldPath)) continue;
      const change = d.kind === "added" ? "added" as const : d.kind === "deleted" ? "removed" as const : "modified" as const;
      const hunks: ChangedHunk[] = d.hunks.map((h) => ({
        oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
        evidenceId: hunkEvidence(store, {
          path: d.path, ...(d.oldPath === undefined ? {} : { oldPath: d.oldPath }), change, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart,
          newLines: h.newLines, lines: h.lines, ...(d.oldOid === undefined ? {} : { oldOid: d.oldOid }), ...(d.newOid === undefined ? {} : { newOid: d.newOid }),
        }, to),
      }));
      const kind = d.kind === "unmerged" || d.kind === "untracked" ? "modified" : d.kind;
      const base = {
        path: d.path, ...(d.oldPath === undefined ? {} : { oldPath: d.oldPath }), kind, ...(d.similarity === undefined ? {} : { similarity: d.similarity }),
        binary: d.binary, ...(d.oldOid === undefined ? {} : { oldOid: d.oldOid }), ...(d.newOid === undefined ? {} : { newOid: d.newOid }),
      };
      // A rename, deletion or binary change also gets one change record (old path, similarity, blobs).
      const record = hunks.length === 0 || d.oldPath !== undefined || d.kind === "deleted" ? [changeEvidence(store, base, to)] : [];
      files.push({ ...base, hunks, evidenceIds: [...hunks.map((h) => h.evidenceId), ...record].sort(compareUtf8) });
    }
  }
  for (const p of untracked) {
    const text = readSourceFile(root, p);
    if (text.value === undefined || text.value.includes("\u0000")) {
      diagnostics.push(...text.diagnostics);
      files.push({ path: p, kind: "untracked", binary: true, hunks: [], evidenceIds: [changeEvidence(store, { path: p, kind: "untracked", binary: true }, to)] });
      continue;
    }
    const body = text.value.endsWith("\n") ? text.value.slice(0, -1) : text.value;
    const lines = body === "" ? [] : body.split("\n").map((l) => `+${l}`);
    const hunk: ChangedHunk = {
      oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length,
      evidenceId: hunkEvidence(store, { path: p, change: "added", oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }, to),
    };
    files.push({ path: p, kind: "untracked", binary: false, hunks: [hunk], evidenceIds: [hunk.evidenceId] });
  }
  files.sort((a, b) => compareUtf8(a.path, b.path));
  const identity = sha256Text(stableJson({
    from, to,
    files: files.map((f) => ({ path: f.path, oldPath: f.oldPath ?? null, kind: f.kind, oldOid: f.oldOid ?? null, newOid: f.newOid ?? null, evidence: f.evidenceIds })),
  }));
  return { value: { files, identity, from, to, diagnostics }, diagnostics };
}
