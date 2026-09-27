/**
 * Batch Git queries for the scanner. Internal: nothing here is exported from the package, so Git
 * CLI details do not leak into the domain model. One subprocess per query, never per file.
 */
import { execFile } from "node:child_process";

export type GitResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface GitIndexEntry {
  readonly path: string;
  /** Octal mode of the entry, e.g. "100644", "120000" (symlink), "160000" (gitlink). */
  readonly mode: string;
  /** Blob OID of stage 0. Absent when the path has unmerged stages. */
  readonly oid?: string;
}

/** Variables that would point Git at another repository or index than the scan root. */
const REDIRECTING_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"];

function runGit(root: string, args: readonly string[]): Promise<GitResult<string>> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of REDIRECTING_ENV) delete env[key];
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd: root, env, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, value: stdout.toString("utf8") });
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        const detail = stderr.toString("utf8").trim();
        resolve({ ok: false, message: missing ? "git executable not found" : detail === "" ? error.message : detail });
      },
    );
  });
}

/** Path of root relative to the work tree top level ("" at the top level). */
export async function gitWorkTreePrefix(root: string): Promise<GitResult<string>> {
  const result = await runGit(root, ["rev-parse", "--show-prefix"]);
  return result.ok ? { ok: true, value: result.value.replace(/\r?\n$/, "") } : result;
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
