/**
 * H-99 (#48 P8a): a changed import that now resolves to a forbidden file, when the same statement existed on
 * the from side with another specifier that resolved to no file. DUO then cannot tell whether the importer
 * already reached the forbidden file, so the claim stays but is not BLOCK-eligible.
 *
 * Both revisions and the actual diff are read (H-99 (3)): the from-side text is analyzed with the same
 * analyzer, and "resolved to no file" is shown, not guessed: a relative specifier none of whose resolution
 * candidates exists in the diff base tree or in the Adoption Baseline commit. A non-relative specifier, a
 * new statement (no from-side statement of the same kind and names), more than one candidate statement, or
 * any existing candidate file keeps the claim BLOCK-eligible (H-99 (2)).
 */
import path from "node:path";
import type { GitBlobSource } from "@duo-director/analyzer";
import type { RepoPath } from "@duo-director/core";
import type { IndexedModuleReference } from "@duo-director/graph";
import type { RuleContext } from "./claims.js";
import type { ChangedFile, ChangedHunk } from "./types.js";

const encoder = new TextEncoder();
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs"];
/** A .js-family specifier also names the TypeScript source next to it (TypeScript resolution). */
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"],
};

const names = (r: { readonly bindings: readonly { readonly imported: string }[]; readonly reexports: readonly { readonly imported: string }[] }) =>
  [...r.bindings.map((b) => b.imported), ...r.reexports.map((x) => x.imported)].sort().join("\u0000");

/** Every file a relative specifier written in `from` could resolve to; undefined when it leaves the repository. */
export function resolutionCandidates(from: RepoPath, specifier: string): string[] | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined)) return undefined;
  const base = joined.replace(/\/$/u, "");
  const ext = path.posix.extname(base);
  const stem = ext === "" ? base : base.slice(0, -ext.length);
  return [
    base, ...EXTENSIONS.map((e) => `${base}${e}`), ...(SOURCE_FOR[ext] ?? []).map((e) => `${stem}${e}`),
    `${base}/package.json`, ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

async function existsIn(ctx: RuleContext, source: GitBlobSource, files: readonly string[]): Promise<boolean> {
  for (const f of files) if ((await ctx.git.readBlob(source, f as RepoPath)).value !== undefined) return true;
  return false;
}

/** The import statement on the changed line replaced a from-side specifier that resolved to no file (H-99 (1)). */
export async function replacedUnresolvedSpecifier(
  ctx: RuleContext, readFromSide: (file: RepoPath) => Promise<string | undefined>, file: ChangedFile, ref: IndexedModuleReference, hunks: readonly ChangedHunk[],
): Promise<boolean> {
  const from = ctx.from;
  if (ctx.registry === undefined || from === "WORKTREE" || file.kind === "added" || file.kind === "untracked") return false;
  const ranges = hunks.filter((h) => h.oldLines > 0).map((h) => [h.oldStart, h.oldStart + h.oldLines - 1] as const);
  if (ranges.length === 0) return false; // only added lines: a new statement
  const oldPath = file.oldPath ?? file.path;
  const text = await readFromSide(oldPath);
  if (text === undefined) return false;
  const analysis = ctx.registry.analyze({ path: oldPath, content: encoder.encode(text) }).value;
  const before = (analysis?.moduleReferences ?? []).filter((r) => {
    const start = r.location.startLine ?? 0;
    return r.kind === ref.kind && names(r) === names(ref) && r.specifier !== ref.specifier
      && ranges.some(([a, b]) => start <= b && (r.location.endLine ?? start) >= a);
  });
  const only = before.length === 1 ? before[0] : undefined;
  if (only === undefined || !(only.specifier.startsWith("./") || only.specifier.startsWith("../"))) return false;
  const candidates = resolutionCandidates(oldPath, only.specifier);
  if (candidates === undefined) return false;
  const sources: GitBlobSource[] = [from === "HEAD" || from === "INDEX" ? from : { commit: from.commit }];
  if (ctx.baselineHeadOid !== undefined) sources.push({ commit: ctx.baselineHeadOid });
  for (const s of sources) if (await existsIn(ctx, s, candidates)) return false;
  return true;
}
