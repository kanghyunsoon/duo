/**
 * Guarded file writes (T13.1, T14). Every DUO write goes through guardWrite(): the core write
 * boundary for the write kind (and an optional narrower caller restriction), then no symlink on
 * any segment of the path, so a link can never redirect a write outside the repository. Writes are
 * atomic replacements (temp file + rename) or exclusive creations (temp file + hard link).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { STATE_DIR_NAME } from "./constants.js";
import { createDiagnostic, failure, success, type ParseResult } from "./diagnostics.js";
import type { RepoPath } from "./paths.js";
import { checkWriteBoundary, WRITE_AREAS, type WriteBoundaryOptions, type WriteKind } from "./write-boundary.js";

export interface GuardedPath {
  readonly path: RepoPath;
  readonly absolute: string;
}

/** The first segment of repoPath under root that is a symlink (or junction), or undefined. */
export function symlinkOnPath(root: string, repoPath: string): string | undefined {
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

function noSymlink(root: string, p: RepoPath): ParseResult<GuardedPath> {
  const link = symlinkOnPath(root, p);
  if (link !== undefined) return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${p}": "${link}" is a symlink`, { path: p })]);
  return success({ path: p, absolute: path.join(root, p) });
}

/** May DUO write this file as this kind? Boundary, caller restriction, no symlink on the path. */
export function guardWrite(root: string, target: string, kind: WriteKind, options: WriteBoundaryOptions = {}): ParseResult<GuardedPath> {
  const checked = checkWriteBoundary(root, target, kind, options);
  if (checked.value === undefined) return failure(checked.diagnostics);
  return noSymlink(root, checked.value.path);
}

/**
 * May DUO create this directory as this kind? The state directory itself, an area directory of the
 * kind (e.g. ".duo-project/specs") or any directory inside one. No symlink on the path.
 */
export function guardDirectory(root: string, target: RepoPath, kind: WriteKind): ParseResult<GuardedPath> {
  const prefix = `${STATE_DIR_NAME}/`;
  if (target === STATE_DIR_NAME) return noSymlink(root, target);
  if (target.startsWith(prefix) && WRITE_AREAS[kind].includes(`${target.slice(prefix.length)}/`)) return noSymlink(root, target);
  return guardWrite(root, target, kind);
}

const tempName = (absolute: string) => `${absolute}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

/** Replaces the file atomically (temp file in the same directory + rename). */
export async function writeFileAtomic(absolute: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temp = tempName(absolute);
  try {
    await fsp.writeFile(temp, text, "utf8");
    await fsp.rename(temp, absolute);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}

/** Creates the file with this content only if it does not exist; false when it exists. */
export async function createFileExclusive(absolute: string, text: string): Promise<boolean> {
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temp = tempName(absolute);
  try {
    await fsp.writeFile(temp, text, "utf8");
    try {
      await fsp.link(temp, absolute); // atomic, fails when the target exists
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw error;
      // File systems without hard links: exclusive create (the content is written right after).
      try {
        await fsp.writeFile(absolute, text, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw inner;
      }
    }
  } finally {
    await fsp.rm(temp, { force: true });
  }
}
