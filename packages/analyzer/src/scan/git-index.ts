/**
 * Batch Git queries for the scanner. Internal: nothing here is exported from the package, so Git
 * CLI details do not leak into the domain model. One subprocess per query, never per file.
 */
import { runGit, type GitResult } from "../git/exec.js";

export type { GitResult };

export interface GitIndexEntry {
  readonly path: string;
  /** Octal mode of the entry, e.g. "100644", "120000" (symlink), "160000" (gitlink). */
  readonly mode: string;
  /** Blob OID of stage 0. Absent when the path has unmerged stages. */
  readonly oid?: string;
}

const STAGE_RECORD = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.+)$/su;

/** Every index entry, one record per path (`git ls-files -z --stage`). */
export async function listIndexEntries(root: string): Promise<GitResult<GitIndexEntry[]>> {
  const result = await runGit(root, ["ls-files", "-z", "--stage"]);
  if (!result.ok) return result;
  const byPath = new Map<string, GitIndexEntry>();
  for (const record of result.value.split("\0")) {
    if (record === "") continue;
    const m = STAGE_RECORD.exec(record);
    if (m === null) return { ok: false, message: `unexpected git ls-files record: ${JSON.stringify(record)}` };
    const [, mode = "", oid = "", stage = "0", path = ""] = m;
    // Stage 0 is the normal entry; stages 1-3 exist only for unmerged paths, which get no OID.
    byPath.set(path, stage === "0" ? { path, mode, oid } : { path, mode });
  }
  return { ok: true, value: [...byPath.values()] };
}

/**
 * Untracked files that are not ignored (`git ls-files -z --others --exclude-standard`), in the
 * spelling Git read from the file system. Nested repositories appear once, with a trailing "/".
 */
export async function listUntrackedPaths(root: string): Promise<GitResult<string[]>> {
  const result = await runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return result.ok ? { ok: true, value: result.value.split("\0").filter((p) => p !== "") } : result;
}

/**
 * Index entries whose working-tree file type differs from the index (`git diff-files --diff-filter=T`).
 * Git applies core.symlinks here: a symlink checked out as a plain file where symlinks are
 * unsupported (Windows default) is not a type change.
 */
export async function listTypeChangedPaths(root: string): Promise<GitResult<Set<string>>> {
  const result = await runGit(root, ["diff-files", "-z", "--name-only", "--diff-filter=T"]);
  return result.ok ? { ok: true, value: new Set(result.value.split("\0").filter((p) => p !== "")) } : result;
}
