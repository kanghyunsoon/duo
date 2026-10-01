/**
 * Reads and writes of DUO's regenerable files (.duo-project/generated, .duo-project/cache) for the
 * Indexer. Writes go through the core write boundary, refuse symlinks on the path and replace the
 * file atomically (temp file + rename), so a reader sees the old or the new file, never a mix.
 */
import fs from "node:fs";
import path from "node:path";
import { checkWriteBoundary, createDiagnostic, failure, success, type ParseResult, type RepoPath } from "@duo-director/core";

/** A symlink anywhere between root and the target would redirect the read or write. */
function symlinkOnPath(root: string, repoPath: string): string | undefined {
  const segments = repoPath.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const partial = segments.slice(0, i).join("/");
    try {
      if (fs.lstatSync(path.join(root, partial)).isSymbolicLink()) return partial;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** File text, undefined when missing, or an error message. */
export function readRegenerable(root: string, repoPath: string): { readonly text?: string; readonly error?: string } {
  if (symlinkOnPath(root, repoPath) !== undefined) return { error: "the path contains a symlink" };
  try {
    return { text: fs.readFileSync(path.join(root, repoPath), "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: (error as Error).message };
  }
}

/** symlinkOnPath with asynchronous lstat: the same segments, in the same order, with the same result. */
async function symlinkOnPathAsync(root: string, repoPath: string): Promise<string | undefined> {
  const segments = repoPath.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const partial = segments.slice(0, i).join("/");
    try {
      if ((await fs.promises.lstat(path.join(root, partial))).isSymbolicLink()) return partial;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** readRegenerable with asynchronous I/O (T25.1): the same checks and the same result for the same file system. Never rejects. */
export async function readRegenerableAsync(root: string, repoPath: string): Promise<{ readonly text?: string; readonly error?: string }> {
  if (await symlinkOnPathAsync(root, repoPath) !== undefined) return { error: "the path contains a symlink" };
  try {
    return { text: await fs.promises.readFile(path.join(root, repoPath), "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: (error as Error).message };
  }
}

export function writeRegenerable(root: string, repoPath: string, text: string): ParseResult<RepoPath> {
  const allowed = checkWriteBoundary(root, repoPath, "regenerable");
  if (allowed.value === undefined) return failure(allowed.diagnostics);
  const target = allowed.value.path;
  const link = symlinkOnPath(root, target);
  if (link !== undefined) return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${target}": "${link}" is a symlink`, { path: target })]);
  const absolute = path.join(root, target);
  const temp = `${absolute}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, absolute);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return failure([createDiagnostic("FILE_WRITE_ERROR", `Cannot write "${target}": ${(error as Error).message}`, { path: target })]);
  }
  return success(target);
}

/** Removes files of a regenerable directory that are not kept. Never follows symlinks. */
export function pruneRegenerableDirectory(root: string, repoDir: string, keep: ReadonlySet<string>): number {
  if (checkWriteBoundary(root, `${repoDir}/x`, "regenerable").value === undefined || symlinkOnPath(root, repoDir) !== undefined) return 0;
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, repoDir), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || keep.has(entry.name)) continue;
    fs.rmSync(path.join(root, repoDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}
