/**
 * Repository file discovery (TASK-004). Git is the canonical path source: tracked files use the
 * Git index spelling, untracked non-ignored files the spelling Git reads from the file system.
 * Ignored files and .git/ are never listed. Symlinks are never followed.
 */
import fs from "node:fs";
import path from "node:path";
import {
  compareDiagnostics, compareUtf8, createDiagnostic, findPathPortabilityCollisions, normalizeRepoPath,
  type Diagnostic, type RepoPath,
} from "@duo-director/core";
import { gitWorkTreePrefix, listIndexEntries, listTypeChangedPaths, listUntrackedPaths, type GitIndexEntry } from "./git-index.js";
import { createPathPolicy } from "./policy.js";
import { buildOutputMatcher } from "./build-output.js";
import type {
  ExcludedFile, ExclusionReason, FileTypeChange, RepositoryFile, RepositoryFileState, RepositoryScan, ScanOptions,
} from "./types.js";

const MODE_SYMLINK = "120000";
const MODE_GITLINK = "160000";
const REGULAR_MODES = new Set(["100644", "100755"]);
/** Longest symlink text read from a checked-out link file (core.symlinks=false). */
const MAX_LINK_TEXT = 4096;

type EntryKind = "file" | "symlink" | "directory" | "missing" | "other";

function entryKind(absolute: string): EntryKind {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    return stat.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/** Text of a symlink without following it. For link files written as plain text (Windows, core.symlinks=false), the file content. */
function linkText(absolute: string, kind: EntryKind): string | undefined {
  try {
    if (kind === "symlink") return fs.readlinkSync(absolute, "utf8");
    if (kind !== "file") return undefined;
    const fd = fs.openSync(absolute, "r");
    try {
      const buffer = Buffer.alloc(MAX_LINK_TEXT);
      const n = fs.readSync(fd, buffer, 0, MAX_LINK_TEXT, 0);
      return buffer.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Resolves link text lexically (nothing is followed) and tells whether it leaves the repository. */
function pointsOutside(root: string, link: RepoPath, target: string | undefined): boolean {
  if (target === undefined) return true;
  const resolved = path.resolve(root, path.dirname(link), target);
  const relative = path.relative(root, resolved);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function symlinkDiagnostic(root: string, link: RepoPath, target: string | undefined): Diagnostic {
  return pointsOutside(root, link, target)
    ? createDiagnostic("SYMLINK_OUTSIDE_REPOSITORY", `Symlink "${link}" points outside the repository; its target is not read`, { path: link })
    : createDiagnostic("SYMLINK_SKIPPED", `Symlink "${link}" is not followed`, { path: link });
}

interface Candidate {
  readonly path: RepoPath;
  readonly state: RepositoryFileState;
  readonly index?: GitIndexEntry;
}

/**
 * Lists the files to index under root, which must be the top level of a Git work tree (DUO MVP
 * requires Git: GIT_REPOSITORY_REQUIRED otherwise). Uses four batch Git queries and one lstat per
 * file and per directory; reads no file content except the text of symlinks checked out as plain files.
 */
export async function scanRepository(root: string, options: ScanOptions = {}): Promise<RepositoryScan> {
  const rootDir = path.resolve(root);
  const fail = (d: Diagnostic): RepositoryScan => ({ files: [], excluded: [], typeChanges: [], diagnostics: [d] });

  const prefix = await gitWorkTreePrefix(rootDir);
  if (!prefix.ok) {
    return fail(prefix.gitMissing === true
      ? createDiagnostic("GIT_COMMAND_FAILED", `Cannot scan "${rootDir}": ${prefix.message}`)
      : createDiagnostic("GIT_REPOSITORY_REQUIRED", `"${rootDir}" is not a Git work tree; DUO requires a Git repository: ${prefix.message}`));
  }
  if (prefix.value !== "") {
    return fail(createDiagnostic("SCAN_ROOT_INVALID", `"${rootDir}" is not the top level of its Git work tree (it is "${prefix.value}")`));
  }
  const [indexResult, untrackedResult, typeChangedResult] = await Promise.all([
    listIndexEntries(rootDir), listUntrackedPaths(rootDir), listTypeChangedPaths(rootDir),
  ]);
  if (!indexResult.ok) return fail(createDiagnostic("GIT_COMMAND_FAILED", `git ls-files --stage failed: ${indexResult.message}`));
  if (!untrackedResult.ok) return fail(createDiagnostic("GIT_COMMAND_FAILED", `git ls-files --others failed: ${untrackedResult.message}`));
  if (!typeChangedResult.ok) return fail(createDiagnostic("GIT_COMMAND_FAILED", `git diff-files failed: ${typeChangedResult.message}`));
  const gitTypeChanged = typeChangedResult.value;

  const policy = createPathPolicy(options.include, options.exclude);
  const diagnostics: Diagnostic[] = policy.invalidPatterns.map((p) =>
    createDiagnostic("INVALID_PATH", `index pattern "${p}" is not a repository-relative glob; it is ignored`));
  const files: RepositoryFile[] = [];
  const excluded: ExcludedFile[] = [];
  const typeChanges: FileTypeChange[] = [];
  const typeChanged = (p: RepoPath, index: FileTypeChange["index"], workingTree: FileTypeChange["workingTree"]) => {
    typeChanges.push({ path: p, index, workingTree });
    diagnostics.push(createDiagnostic("FILE_TYPE_CHANGED", `"${p}" is a ${index} in the Git index but a ${workingTree} in the working tree`, { path: p }));
  };
  const exclude = (c: { path: RepoPath; state: RepositoryFileState }, reason: ExclusionReason) =>
    excluded.push({ path: c.path, state: c.state, reason });

  const candidates: Candidate[] = [];
  const addCandidate = (raw: string, state: RepositoryFileState, index?: GitIndexEntry) => {
    const nested = raw.endsWith("/");
    const spelled = nested ? raw.slice(0, -1) : raw;
    const normalized = normalizeRepoPath(spelled).value;
    if (normalized === undefined || normalized !== spelled) {
      // For example a backslash in a Linux file name: it would change meaning as a RepoPath.
      diagnostics.push(createDiagnostic("SCAN_ENTRY_SKIPPED", `${JSON.stringify(raw)} is not a portable repository path`));
      return;
    }
    const candidate = index === undefined ? { path: normalized, state } : { path: normalized, state, index };
    if (nested || index?.mode === MODE_GITLINK) {
      exclude(candidate, "nested-repository");
      diagnostics.push(createDiagnostic("SCAN_ENTRY_SKIPPED", `"${normalized}" is a nested repository or submodule`, { path: normalized }));
      return;
    }
    candidates.push(candidate);
  };
  for (const entry of indexResult.value) addCandidate(entry.path, "tracked", entry);
  for (const raw of untrackedResult.value) addCandidate(raw, "untracked");

  const directories = new Map<string, EntryKind>();
  // One diagnostic per symlink, whether it is found as an entry or as the ancestor of tracked files.
  const reportedSymlinks = new Set<string>();
  const reportSymlink = (link: RepoPath, kind: EntryKind) => {
    if (reportedSymlinks.has(link)) return;
    reportedSymlinks.add(link);
    diagnostics.push(symlinkDiagnostic(rootDir, link, linkText(path.join(rootDir, link), kind)));
  };
  const directoryKind = (dir: string): EntryKind => {
    let kind = directories.get(dir);
    if (kind === undefined) {
      kind = entryKind(path.join(rootDir, dir));
      directories.set(dir, kind);
    }
    return kind;
  };

  const buildOutput = buildOutputMatcher(candidates.map((c) => c.path));
  for (const candidate of candidates) {
    const reason = policy.exclusionOf(candidate.path) ?? (buildOutput(candidate.path) ? "build-output" : undefined);
    if (reason !== undefined) {
      exclude(candidate, reason);
      continue;
    }
    // An ancestor directory that became a symlink must not be traversed.
    const segments = candidate.path.split("/");
    let blocked: { dir: RepoPath; kind: EntryKind } | undefined;
    for (let i = 1; i < segments.length && blocked === undefined; i++) {
      const dir = segments.slice(0, i).join("/");
      const kind = directoryKind(dir);
      if (kind !== "directory") blocked = { dir: dir as RepoPath, kind };
    }
    if (blocked !== undefined) {
      if (blocked.kind === "symlink") {
        exclude(candidate, "symlink");
        reportSymlink(blocked.dir, "symlink");
      } else {
        exclude(candidate, "missing");
      }
      continue;
    }
    const absolute = path.join(rootDir, candidate.path);
    const kind = entryKind(absolute);
    const indexMode = candidate.index?.mode;
    // Index symlink, working-tree regular file, and Git (with core.symlinks) calls it a type change.
    const symlinkReplacedByFile = indexMode === MODE_SYMLINK && kind === "file" && gitTypeChanged.has(candidate.path);
    if (symlinkReplacedByFile) {
      typeChanged(candidate.path, "symlink", "regular-file");
      files.push({ path: candidate.path, state: candidate.state });
      continue;
    }
    if (kind === "symlink" || indexMode === MODE_SYMLINK) {
      if (kind === "missing") {
        exclude(candidate, "missing");
        continue;
      }
      if (kind === "symlink" && indexMode !== undefined && REGULAR_MODES.has(indexMode)) typeChanged(candidate.path, "regular-file", "symlink");
      exclude(candidate, "symlink");
      reportSymlink(candidate.path, kind);
      continue;
    }
    if (kind === "missing") {
      exclude(candidate, "missing");
      continue;
    }
    if (kind !== "file") {
      exclude(candidate, "unsupported-entry");
      diagnostics.push(createDiagnostic("SCAN_ENTRY_SKIPPED", `"${candidate.path}" is not a regular file`, { path: candidate.path }));
      continue;
    }
    const oid = candidate.index?.oid;
    files.push(oid === undefined ? { path: candidate.path, state: candidate.state } : { path: candidate.path, state: candidate.state, gitBlobOid: oid });
  }

  files.sort((a, b) => compareUtf8(a.path, b.path));
  excluded.sort((a, b) => compareUtf8(a.path, b.path));
  typeChanges.sort((a, b) => compareUtf8(a.path, b.path));
  diagnostics.push(...findPathPortabilityCollisions(files.map((f) => f.path)));
  return { files, excluded, typeChanges, diagnostics: diagnostics.sort(compareDiagnostics) };
}
