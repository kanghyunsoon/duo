/**
 * Parsers for Git's machine-readable output (TASK-006). Internal: the domain types in ./types.ts are
 * the contract. All inputs are -z (NUL-separated) forms, so paths with spaces, tabs, newlines,
 * quotes or Unicode need no unquoting. Parsers throw GitOutputError on anything unexpected.
 */
import type { RepoPath } from "@duo-director/core";
import type { GitChangeKind, GitDiffHunk, GitRangeChange, GitWorkingTreeChange } from "./types.js";

export class GitOutputError extends Error {}

/** Converts a Git path to a RepoPath, or undefined when it cannot be one (the caller reports it). */
export type PathConverter = (gitPath: string) => RepoPath | undefined;

const ZERO_OID = /^0+$/;
const MODE_GITLINK = "160000";
const oidOf = (oid: string) => (ZERO_OID.test(oid) ? undefined : oid);
const modeOf = (mode: string) => (mode === "000000" ? undefined : mode);

const LETTER: Readonly<Record<string, GitChangeKind>> = {
  A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged",
};

function kindOf(letter: string): GitChangeKind | undefined {
  if (letter === ".") return undefined;
  const kind = LETTER[letter];
  if (kind === undefined) throw new GitOutputError(`unknown change letter "${letter}"`);
  return kind;
}

const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value } as Record<K, V>);

export interface StatusHeader {
  /** undefined when unborn ("(initial)"). */
  readonly oid?: string;
  /** undefined when detached. */
  readonly head?: string;
}

export interface ParsedStatus {
  readonly header: StatusHeader;
  readonly changes: GitWorkingTreeChange[];
  /** Git paths that are not RepoPaths. */
  readonly skipped: string[];
}

const ORDINARY = /^1 (.)(.) (\S{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.*)$/su;
const RENAMED = /^2 (.)(.) (\S{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d+) (.*)$/su;
const UNMERGED = /^u (..) (\S{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.*)$/su;

/** git status --porcelain=v2 -z [--branch]. */
export function parseStatusV2(out: string, toPath: PathConverter): ParsedStatus {
  const tokens = out.split("\0");
  let oid: string | undefined;
  let head: string | undefined;
  const changes: GitWorkingTreeChange[] = [];
  const skipped: string[] = [];
  const path = (raw: string) => {
    const p = toPath(raw);
    if (p === undefined) skipped.push(raw);
    return p;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t === "") continue;
    if (t.startsWith("# branch.oid ")) {
      const v = t.slice("# branch.oid ".length);
      oid = v === "(initial)" ? undefined : v;
      continue;
    }
    if (t.startsWith("# branch.head ")) {
      const v = t.slice("# branch.head ".length);
      head = v === "(detached)" ? undefined : v;
      continue;
    }
    if (t.startsWith("# ") || t.startsWith("! ")) continue;
    if (t.startsWith("? ")) {
      let raw = t.slice(2);
      const nested = raw.endsWith("/");
      if (nested) raw = raw.slice(0, -1);
      const p = path(raw);
      if (p !== undefined) changes.push({ path: p, unstaged: "untracked", submodule: nested });
      continue;
    }
    let m = ORDINARY.exec(t);
    if (m !== null) {
      const [, x = ".", y = ".", sub = "N...", mH = "", mI = "", mW = "", hH = "", hI = "", raw = ""] = m;
      const p = path(raw);
      if (p !== undefined) {
        changes.push({
          path: p, ...optional("staged", kindOf(x)), ...optional("unstaged", kindOf(y)), submodule: sub.startsWith("S"),
          ...optional("headMode", modeOf(mH)), ...optional("indexMode", modeOf(mI)), ...optional("worktreeMode", modeOf(mW)),
          ...optional("headOid", oidOf(hH)), ...optional("indexOid", oidOf(hI)),
        });
      }
      continue;
    }
    m = RENAMED.exec(t);
    if (m !== null) {
      const [, x = ".", y = ".", sub = "N...", mH = "", mI = "", mW = "", hH = "", hI = "", , score = "0", raw = ""] = m;
      const origRaw = tokens[++i];
      if (origRaw === undefined) throw new GitOutputError("rename record without original path");
      const p = path(raw);
      const orig = path(origRaw);
      if (p !== undefined && orig !== undefined) {
        changes.push({
          path: p, oldPath: orig, similarity: Number(score), ...optional("staged", kindOf(x)), ...optional("unstaged", kindOf(y)),
          submodule: sub.startsWith("S"),
          ...optional("headMode", modeOf(mH)), ...optional("indexMode", modeOf(mI)), ...optional("worktreeMode", modeOf(mW)),
          ...optional("headOid", oidOf(hH)), ...optional("indexOid", oidOf(hI)),
        });
      }
      continue;
    }
    m = UNMERGED.exec(t);
    if (m !== null) {
      const [, xy = "UU", sub = "N...", , , , mW = "", , , , raw = ""] = m;
      const p = path(raw);
      if (p !== undefined) {
        changes.push({ path: p, staged: "unmerged", unstaged: "unmerged", conflict: xy, submodule: sub.startsWith("S"), ...optional("worktreeMode", modeOf(mW)) });
      }
      continue;
    }
    throw new GitOutputError(`unexpected status record ${JSON.stringify(t.slice(0, 80))}`);
  }
  return { header: { ...optional("oid", oid), ...optional("head", head) }, changes, skipped };
}

const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/u;

export interface ParsedRawDiff {
  readonly changes: GitRangeChange[];
  readonly skipped: string[];
  /** Offset just after the raw records (and the NUL that separates them from a patch). */
  readonly end: number;
}

/** git diff --raw -z [-p]: records ":<modes> <oids> <status>\0<path>\0[<path>\0]", optionally followed by a patch. */
export function parseRawDiff(out: string, toPath: PathConverter): ParsedRawDiff {
  const changes: GitRangeChange[] = [];
  const skipped: string[] = [];
  let pos = 0;
  const next = () => {
    const end = out.indexOf("\0", pos);
    if (end === -1) throw new GitOutputError("truncated raw diff record");
    const token = out.slice(pos, end);
    pos = end + 1;
    return token;
  };
  while (out[pos] === ":") {
    const meta = next();
    const m = RAW.exec(meta);
    if (m === null) throw new GitOutputError(`unexpected raw diff record ${JSON.stringify(meta)}`);
    const [, srcMode = "", dstMode = "", srcOid = "", dstOid = "", letter = "", score = ""] = m;
    const kind = kindOf(letter);
    if (kind === undefined) throw new GitOutputError("raw diff record without status");
    const first = next();
    const second = letter === "R" || letter === "C" ? next() : undefined;
    const oldP = toPath(first);
    const newP = second === undefined ? oldP : toPath(second);
    if (oldP === undefined || newP === undefined) {
      skipped.push(second ?? first);
      continue;
    }
    changes.push({
      path: newP, ...(second === undefined ? {} : { oldPath: oldP }), ...(score === "" ? {} : { similarity: Number(score) }),
      kind, submodule: srcMode === MODE_GITLINK || dstMode === MODE_GITLINK,
      ...optional("oldMode", modeOf(srcMode)), ...optional("newMode", modeOf(dstMode)),
      ...optional("oldOid", oidOf(srcOid)), ...optional("newOid", oidOf(dstOid)),
    });
  }
  if (out[pos] === "\0") pos++;
  return { changes, skipped, end: pos };
}

/** Splits the patch part of git diff -p into one block per file ("diff --git" header). */
export function splitPatches(patch: string): string[] {
  const starts: number[] = [];
  const re = /^diff --git /gmu;
  for (let m = re.exec(patch); m !== null; m = re.exec(patch)) starts.push(m.index);
  return starts.map((s, i) => patch.slice(s, starts[i + 1] ?? patch.length));
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u;

/** One file's patch block: binary flag and hunks. Hunk lines keep their prefix; anything else ends the hunk. */
export function parsePatchBlock(block: string): { binary: boolean; hunks: GitDiffHunk[] } {
  const lines = block.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: GitDiffHunk[] = [];
  let binary = false;
  let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: string[] } | undefined;
  for (const line of lines) {
    const h = HUNK.exec(line);
    if (h !== null) {
      const [, os = "0", ol, ns = "0", nl, section = ""] = h;
      current = { oldStart: Number(os), oldLines: ol === undefined ? 1 : Number(ol), newStart: Number(ns), newLines: nl === undefined ? 1 : Number(nl), section, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current !== undefined && /^[ +\-\\]/u.test(line)) {
      current.lines.push(line);
      continue;
    }
    current = undefined;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
  }
  return { binary, hunks };
}

/** git ls-tree -r -z / git ls-files -s -z records: "<mode> <type-or-oid> ..." → path → oid (blobs; stage 0). */
export function parseLsTree(out: string, toPath: PathConverter): Map<RepoPath, string> {
  const result = new Map<RepoPath, string>();
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/su.exec(record);
    if (m === null) throw new GitOutputError(`unexpected ls-tree record ${JSON.stringify(record.slice(0, 80))}`);
    const [, , type, oid = "", raw = ""] = m;
    const p = toPath(raw);
    if (type === "blob" && p !== undefined) result.set(p, oid);
  }
  return result;
}

export function parseLsFilesStage(out: string, toPath: PathConverter): Map<RepoPath, string | undefined> {
  const result = new Map<RepoPath, string | undefined>();
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.*)$/su.exec(record);
    if (m === null) throw new GitOutputError(`unexpected ls-files record ${JSON.stringify(record.slice(0, 80))}`);
    const [, mode = "", oid = "", stage = "0", raw = ""] = m;
    const p = toPath(raw);
    if (p === undefined || mode === MODE_GITLINK) continue;
    result.set(p, stage === "0" ? oid : undefined);
  }
  return result;
}

/** git log -z --format=%H%x00%P%x00%B: three NUL-separated fields per commit. */
export function parseLogMessages(out: string): { oid: string; parents: string[]; message: string }[] {
  const tokens = out.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  if (tokens.length % 3 !== 0) throw new GitOutputError("unexpected git log record count");
  const commits: { oid: string; parents: string[]; message: string }[] = [];
  for (let i = 0; i < tokens.length; i += 3) {
    const oid = tokens[i] ?? "";
    if (!/^[0-9a-f]+$/u.test(oid)) throw new GitOutputError(`unexpected commit id ${JSON.stringify(oid)}`);
    const parents = (tokens[i + 1] ?? "").split(" ").filter((p) => p !== "");
    commits.push({ oid, parents, message: (tokens[i + 2] ?? "").replace(/\n$/u, "") });
  }
  return commits;
}

/** git log -z --format=%x1e%H --name-only: "\x1e<oid>\0\n<path>\0<path>\0...". */
export function parseLogFiles(out: string, toPath: PathConverter): Map<string, RepoPath[]> {
  const result = new Map<string, RepoPath[]>();
  for (const chunk of out.split("\u001e")) {
    if (chunk === "") continue;
    const [oid = "", ...rest] = chunk.split("\0");
    const files: RepoPath[] = [];
    rest.forEach((raw, i) => {
      const name = i === 0 && raw.startsWith("\n") ? raw.slice(1) : raw;
      if (name === "") return;
      const p = toPath(name);
      if (p !== undefined) files.push(p);
    });
    result.set(oid, files);
  }
  return result;
}
