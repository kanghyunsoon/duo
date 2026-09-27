/**
 * GitProvider (TASK-006): read-only Git facts for Evidence provenance. It never commits, checks out,
 * stages or fetches, and it does not update the Graph or decide freshness. Every query is one or a
 * few batch Git processes, never one per file.
 */
import fs from "node:fs";
import path from "node:path";
import {
  compareUtf8, createDiagnostic, failure, normalizeRepoPath, success,
  type Diagnostic, type ParseResult, type RepoPath,
} from "@duo-director/core";
import { runGit, runGitBytes, type GitResult } from "./exec.js";
import {
  GitOutputError, parseLogFiles, parseLogMessages, parseLsFilesStage, parseLsTree, parsePatchBlock, parseRawDiff,
  parseStatusV2, splitPatches, type PathConverter,
} from "./parse.js";
import type {
  GitBlobProvenance, GitBlobSource, GitCommit, GitDiffEnd, GitDiffRequest, GitFileDiff, GitObjectFormat, GitRangeChange,
  GitRepositoryState, GitWorkingTreeChange,
} from "./types.js";

const EMPTY_TREE: Readonly<Record<GitObjectFormat, string>> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

/** Flags that pin diff output regardless of the user's diff.* configuration. */
const DIFF_FLAGS = [
  "--no-color", "--no-ext-diff", "--no-textconv", "--no-abbrev", "-M", "--diff-algorithm=myers", "--indent-heuristic",
  "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=none", "--submodule=short", "--no-relative",
];

export interface GitProvider {
  /** Absolute work tree root on this host. Not part of any domain value. */
  readonly root: string;
  repositoryState(): Promise<ParseResult<GitRepositoryState>>;
  /** Status of every changed, deleted or untracked (not ignored) path: staged and unstaged axes. */
  listWorkingTreeChanges(): Promise<ParseResult<GitWorkingTreeChange[]>>;
  /** Changed paths between two endpoints (metadata only). */
  listChanges(from: GitDiffEnd, to: GitDiffEnd): Promise<ParseResult<GitRangeChange[]>>;
  /** Hunks for the requested files only. */
  getDiff(request: GitDiffRequest): Promise<ParseResult<GitFileDiff[]>>;
  /** HEAD and index blob OIDs, for the given paths or every tracked path. */
  blobProvenance(paths?: readonly RepoPath[]): Promise<ParseResult<GitBlobProvenance[]>>;
  /** Blob bytes at HEAD, in the index, or at a commit (e.g. the Decision Lock baseline). */
  readBlob(source: GitBlobSource, file: RepoPath): Promise<ParseResult<Uint8Array>>;
  /** Most recent commits reachable from a revision (default HEAD), newest first. Empty when unborn. */
  listCommits(options?: { readonly maxCommits?: number; readonly from?: string }): Promise<ParseResult<GitCommit[]>>;
}

const gitFailed = (what: string, r: { message: string }) => createDiagnostic("GIT_COMMAND_FAILED", `${what} failed: ${r.message}`);

class Provider implements GitProvider {
  constructor(readonly root: string) {}

  private skippedDiagnostics(skipped: readonly string[]): Diagnostic[] {
    return skipped.map((raw) => createDiagnostic("SCAN_ENTRY_SKIPPED", `${JSON.stringify(raw)} is not a portable repository path`));
  }

  private readonly toPath: PathConverter = (raw) => {
    const p = normalizeRepoPath(raw).value;
    return p === raw ? p : undefined;
  };

  private async git(what: string, args: readonly string[], input?: string): Promise<GitResult<string>> {
    return runGit(this.root, args, input === undefined ? {} : { input });
  }

  private async objectFormat(): Promise<GitObjectFormat> {
    const r = await this.git("rev-parse", ["rev-parse", "--show-object-format"]);
    return r.ok && r.value.trim() === "sha256" ? "sha256" : "sha1";
  }

  /** Resolves a revision to a commit OID. Leading "-" (option injection) and control characters are rejected. */
  private async resolveCommit(rev: string): Promise<ParseResult<string>> {
    if (rev === "" || rev.startsWith("-") || [...rev].some((c) => c.charCodeAt(0) < 0x20)) {
      return failure([createDiagnostic("GIT_REQUEST_INVALID", `Invalid revision ${JSON.stringify(rev)}`)]);
    }
    const r = await this.git("rev-parse", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    const oid = r.ok ? r.value.trim() : "";
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(oid)) {
      return failure([createDiagnostic("GIT_REVISION_NOT_FOUND", `Revision ${JSON.stringify(rev)} is not a commit`)]);
    }
    return success(oid);
  }

  private async head(): Promise<string | undefined> {
    const r = await this.resolveCommit("HEAD");
    return r.value;
  }

  async repositoryState(): Promise<ParseResult<GitRepositoryState>> {
    const [status, meta] = await Promise.all([
      this.git("status", ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=no", "--ignore-submodules=all"]),
      this.git("rev-parse", ["rev-parse", "--show-object-format", "--is-shallow-repository"]),
    ]);
    if (!status.ok) return failure([gitFailed("git status", status)]);
    if (!meta.ok) return failure([gitFailed("git rev-parse", meta)]);
    let header;
    try {
      header = parseStatusV2(status.value, this.toPath).header;
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
    const [format = "sha1", shallow = "false"] = meta.value.split(/\r?\n/u);
    const unborn = header.oid === undefined;
    let rootCommitOids: string[] = [];
    if (!unborn) {
      const roots = await this.git("rev-list", ["rev-list", "--max-parents=0", "HEAD"]);
      if (!roots.ok) return failure([gitFailed("git rev-list", roots)]);
      rootCommitOids = roots.value.split(/\r?\n/u).filter((l) => l !== "").sort(compareUtf8);
    }
    return success({
      objectFormat: format.trim() === "sha256" ? "sha256" : "sha1",
      ...(header.oid === undefined ? {} : { headOid: header.oid }),
      ...(header.head === undefined ? {} : { branch: header.head }),
      detached: header.head === undefined,
      unborn,
      shallow: shallow.trim() === "true",
      rootCommitOids,
    });
  }

  async listWorkingTreeChanges(): Promise<ParseResult<GitWorkingTreeChange[]>> {
    const r = await this.git("status", ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames", "--ignore-submodules=none"]);
    if (!r.ok) return failure([gitFailed("git status", r)]);
    try {
      const parsed = parseStatusV2(r.value, this.toPath);
      return success(parsed.changes.sort((a, b) => compareUtf8(a.path, b.path)), this.skippedDiagnostics(parsed.skipped));
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
  }

  /** git diff arguments selecting the two endpoints. */
  private async endpoints(from: GitDiffEnd, to: GitDiffEnd): Promise<ParseResult<string[]>> {
    const commitOf = async (end: GitDiffEnd): Promise<ParseResult<string>> => {
      if (end === "HEAD") return this.resolveCommit("HEAD");
      if (typeof end === "object") return this.resolveCommit(end.commit);
      return failure([]);
    };
    const invalid = () => failure<string[]>([createDiagnostic("GIT_REQUEST_INVALID", `Unsupported diff ${JSON.stringify(from)} → ${JSON.stringify(to)}`)]);
    if (from === "HEAD" && to === "INDEX") return success(["--cached"]);
    if (from === "INDEX" && to === "WORKTREE") return success([]);
    if (from === "HEAD" && to === "WORKTREE") {
      const head = await this.head();
      return success([head ?? EMPTY_TREE[await this.objectFormat()]]);
    }
    if (typeof from === "object" || (from === "HEAD" && typeof to === "object")) {
      const a = await commitOf(from);
      if (a.value === undefined) return failure(a.diagnostics);
      if (to === "INDEX") return success(["--cached", a.value]);
      if (to === "WORKTREE") return success([a.value]);
      const b = await commitOf(to);
      if (b.value === undefined) return failure(b.diagnostics.length > 0 ? b.diagnostics : invalid().diagnostics);
      return success([a.value, b.value]);
    }
    return invalid();
  }

  async listChanges(from: GitDiffEnd, to: GitDiffEnd): Promise<ParseResult<GitRangeChange[]>> {
    const ends = await this.endpoints(from, to);
    if (ends.value === undefined) return failure(ends.diagnostics);
    const r = await this.git("diff", ["diff", "--raw", "-z", ...DIFF_FLAGS, ...ends.value]);
    if (!r.ok) return failure([gitFailed("git diff", r)]);
    try {
      const parsed = parseRawDiff(r.value, this.toPath);
      return success(parsed.changes.sort((a, b) => compareUtf8(a.path, b.path)), this.skippedDiagnostics(parsed.skipped));
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
  }

  async getDiff(request: GitDiffRequest): Promise<ParseResult<GitFileDiff[]>> {
    if (request.files.length === 0) {
      return failure([createDiagnostic("GIT_REQUEST_INVALID", "getDiff needs at least one file; whole-repository diffs are not produced")]);
    }
    const context = request.contextLines ?? 3;
    if (!Number.isInteger(context) || context < 0) return failure([createDiagnostic("GIT_REQUEST_INVALID", "contextLines must be a non-negative integer")]);
    const ends = await this.endpoints(request.from, request.to);
    if (ends.value === undefined) return failure(ends.diagnostics);
    const pathspecs = [...new Set(request.files.flatMap((f) => (f.oldPath === undefined ? [f.path] : [f.path, f.oldPath])))];
    const r = await this.git("diff", ["--literal-pathspecs", "diff", "--raw", "-p", "-z", ...DIFF_FLAGS, `-U${context}`, ...ends.value, "--", ...pathspecs]);
    if (!r.ok) return failure([gitFailed("git diff", r)]);
    let diffs: GitFileDiff[];
    let skipped: string[];
    try {
      const raw = parseRawDiff(r.value, this.toPath);
      skipped = raw.skipped;
      // Unmerged paths print "* Unmerged path" instead of a diff block.
      const withBlocks = raw.changes.filter((c) => c.kind !== "unmerged");
      const blocks = splitPatches(r.value.slice(raw.end));
      if (blocks.length !== withBlocks.length) {
        throw new GitOutputError(`${withBlocks.length} raw records but ${blocks.length} patch blocks`);
      }
      const byChange = new Map(withBlocks.map((c, i) => [c, parsePatchBlock(blocks[i] ?? "")] as const));
      diffs = raw.changes.map((c) => {
        const p = byChange.get(c) ?? { binary: false, hunks: [] };
        return { ...c, binary: p.binary, hunks: p.hunks };
      });
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
    const sized = await this.binarySizes(diffs, request.to);
    return success(sized.sort((a, b) => compareUtf8(a.path, b.path)), this.skippedDiagnostics(skipped));
  }

  /** Blob sizes of binary files: one git cat-file --batch-check for all OIDs, lstat for the working tree side. */
  private async binarySizes(diffs: GitFileDiff[], to: GitDiffEnd): Promise<GitFileDiff[]> {
    const oids = [...new Set(diffs.filter((d) => d.binary).flatMap((d) => [d.oldOid, d.newOid]).filter((o): o is string => o !== undefined))];
    const sizes = new Map<string, number>();
    if (oids.length > 0) {
      const r = await this.git("cat-file", ["cat-file", "--batch-check=%(objectname) %(objectsize)"], oids.join("\n") + "\n");
      if (r.ok) {
        for (const line of r.value.split(/\r?\n/u)) {
          const [oid, size] = line.split(" ");
          if (oid !== undefined && size !== undefined && /^\d+$/u.test(size)) sizes.set(oid, Number(size));
        }
      }
    }
    return diffs.map((d) => {
      if (!d.binary) return d;
      const oldSize = d.oldOid === undefined ? undefined : sizes.get(d.oldOid);
      let newSize = d.newOid === undefined ? undefined : sizes.get(d.newOid);
      if (newSize === undefined && to === "WORKTREE" && d.kind !== "deleted") {
        try {
          newSize = fs.lstatSync(path.join(this.root, d.path)).size;
        } catch {
          newSize = undefined;
        }
      }
      return { ...d, ...(oldSize === undefined ? {} : { oldSize }), ...(newSize === undefined ? {} : { newSize }) };
    });
  }

  async blobProvenance(paths?: readonly RepoPath[]): Promise<ParseResult<GitBlobProvenance[]>> {
    const spec = paths === undefined ? [] : ["--", ...paths];
    if (paths !== undefined && paths.length === 0) return success([]);
    const head = await this.head();
    const [tree, index] = await Promise.all([
      head === undefined ? Promise.resolve<GitResult<string>>({ ok: true, value: "" }) : this.git("ls-tree", ["--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", head, ...spec]),
      this.git("ls-files", ["--literal-pathspecs", "ls-files", "-s", "-z", ...spec]),
    ]);
    if (!tree.ok) return failure([gitFailed("git ls-tree", tree)]);
    if (!index.ok) return failure([gitFailed("git ls-files", index)]);
    try {
      const headOids = parseLsTree(tree.value, this.toPath);
      const indexOids = parseLsFilesStage(index.value, this.toPath);
      const all = [...new Set([...headOids.keys(), ...indexOids.keys()])].sort(compareUtf8);
      return success(all.map((p) => {
        const h = headOids.get(p);
        const i = indexOids.get(p);
        return { path: p, ...(h === undefined ? {} : { headBlobOid: h }), ...(i === undefined ? {} : { indexBlobOid: i }) };
      }));
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
  }

  async readBlob(source: GitBlobSource, file: RepoPath): Promise<ParseResult<Uint8Array>> {
    let spec: string;
    if (source === "INDEX") spec = `:0:${file}`;
    else {
      const commit = await this.resolveCommit(source === "HEAD" ? "HEAD" : source.commit);
      if (commit.value === undefined) return failure(commit.diagnostics);
      spec = `${commit.value}:${file}`;
    }
    const r = await runGitBytes(this.root, ["cat-file", "blob", spec]);
    if (!r.ok) return failure([createDiagnostic("GIT_OBJECT_NOT_FOUND", `No blob for "${file}" at ${JSON.stringify(source)}`, { path: file })]);
    return success(new Uint8Array(r.value));
  }

  async listCommits(options: { readonly maxCommits?: number; readonly from?: string } = {}): Promise<ParseResult<GitCommit[]>> {
    const max = options.maxCommits ?? 500;
    if (!Number.isInteger(max) || max < 1) return failure([createDiagnostic("GIT_REQUEST_INVALID", "maxCommits must be a positive integer")]);
    const start = await this.resolveCommit(options.from ?? "HEAD");
    if (start.value === undefined) {
      // An unborn repository has no history.
      return options.from === undefined ? success([]) : failure(start.diagnostics);
    }
    const common = ["-c", "log.showSignature=false", "log", "-z", "--no-color", `-n${max}`];
    const [messages, files] = await Promise.all([
      this.git("log", [...common, "--format=%H%x00%P%x00%B", start.value]),
      this.git("log", [...common, "--format=%x1e%H", "--name-only", "--no-renames", start.value]),
    ]);
    if (!messages.ok) return failure([gitFailed("git log", messages)]);
    if (!files.ok) return failure([gitFailed("git log", files)]);
    try {
      const names = parseLogFiles(files.value, this.toPath);
      return success(parseLogMessages(messages.value).map((c) => ({ ...c, files: [...(names.get(c.oid) ?? [])].sort(compareUtf8) })));
    } catch (error) {
      return failure([createDiagnostic("GIT_OUTPUT_UNEXPECTED", (error as Error).message)]);
    }
  }
}

/** Opens a provider for the top level of a Git work tree (GIT_REPOSITORY_REQUIRED / SCAN_ROOT_INVALID otherwise). */
export async function openGitProvider(root: string): Promise<ParseResult<GitProvider>> {
  const rootDir = path.resolve(root);
  const r = await runGit(rootDir, ["rev-parse", "--show-prefix"]);
  if (!r.ok) {
    return failure([r.gitMissing === true
      ? createDiagnostic("GIT_COMMAND_FAILED", r.message)
      : createDiagnostic("GIT_REPOSITORY_REQUIRED", `"${rootDir}" is not a Git work tree; DUO requires a Git repository: ${r.message}`)]);
  }
  const prefix = r.value.replace(/\r?\n$/u, "");
  if (prefix !== "") return failure([createDiagnostic("SCAN_ROOT_INVALID", `"${rootDir}" is not the top level of its Git work tree (it is "${prefix}")`)]);
  return success(new Provider(rootDir));
}
