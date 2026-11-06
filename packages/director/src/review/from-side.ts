/**
 * H-99 (#48 P8a): a changed import that now resolves to a forbidden file, when the same statement existed on
 * the from side with another specifier that resolved to no file. DUO then cannot tell whether the importer
 * already reached the forbidden file, so the claim stays but is not BLOCK-eligible.
 *
 * Both revisions and the actual diff are read (H-99 (3)): the from-side text is analyzed with the same
 * analyzer, and "resolved to no file" is shown, not guessed: a relative specifier none of whose resolution
 * candidates exists in the diff base tree or in the Adoption Baseline commit. A non-relative specifier, a
 * new statement (no from-side statement of the same kind and names, or a statement with no names), more than
 * one candidate statement, or any existing candidate file keeps the claim BLOCK-eligible (H-99 (2)).
 */
import path from "node:path";
import type { GitBlobSource } from "@duo-director/analyzer";
import type { RepoPath } from "@duo-director/core";
import type { IndexedModuleReference } from "@duo-director/graph";
import type { RuleContext } from "./claims.js";
import type { ChangedFile, ChangedHunk } from "./types.js";

const encoder = new TextEncoder();
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
/** A .js-family specifier also names the TypeScript source next to it (TypeScript resolution). */
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"],
};

type Statement = { readonly bindings: readonly { readonly local: string; readonly imported: string }[]; readonly reexports: readonly { readonly exported: string; readonly imported: string }[] };

/**
 * What identifies a statement besides its specifier. A named binding is its imported name. A default or
 * namespace binding ("default", "*") says nothing on its own, so its local (or, for a re-export, exported)
 * name is part of it. A bare `export * from` names nothing. Undefined for a statement with no names (a
 * side-effect import, a dynamic import or a bare `export * from`): nothing ties it to a from-side statement,
 * so it is a new statement (H-99 (2)).
 */
const names = (r: Statement): string | undefined => {
  const anonymous = (imported: string) => imported === "default" || imported === "*";
  const parts = [
    ...r.bindings.map((b) => (anonymous(b.imported) ? `${b.imported} as ${b.local}` : b.imported)),
    ...r.reexports.filter((x) => x.exported !== "*").map((x) => (anonymous(x.imported) ? `export ${x.imported} as ${x.exported}` : x.imported)),
  ];
  return parts.length === 0 ? undefined : parts.sort().join("\u0000");
};

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

/** Every statement of `ref`'s kind and names that starts or ends inside one of the line ranges. */
function statementsIn(ctx: RuleContext, file: RepoPath, text: string, ref: IndexedModuleReference, own: string, ranges: readonly (readonly [number, number])[]) {
  const analysis = ctx.registry?.analyze({ path: file, content: encoder.encode(text) }).value;
  return (analysis?.moduleReferences ?? []).filter((r) => {
    const start = r.location.startLine ?? 0;
    return r.kind === ref.kind && names(r) === own && ranges.some(([a, b]) => start <= b && (r.location.endLine ?? start) >= a);
  });
}

/**
 * The import statement on the changed line replaced a from-side specifier that resolved to no file (H-99 (1)).
 * The pairing is one to one: the changed lines hold exactly one statement of this kind and names on each side,
 * with different specifiers. A second statement on the to side, or the from-side statement kept as it was, means
 * the diff added a statement, which stays BLOCK-eligible (H-99 (2)).
 */
export async function replacedUnresolvedSpecifier(
  ctx: RuleContext, readSide: { readonly from: (file: RepoPath) => Promise<string | undefined>; readonly to: (file: RepoPath) => Promise<string | undefined> },
  file: ChangedFile, ref: IndexedModuleReference, hunks: readonly ChangedHunk[],
): Promise<boolean> {
  const from = ctx.from;
  if (ctx.registry === undefined || from === "WORKTREE" || file.kind === "added" || file.kind === "untracked") return false;
  const oldRanges = hunks.filter((h) => h.oldLines > 0).map((h) => [h.oldStart, h.oldStart + h.oldLines - 1] as const);
  if (oldRanges.length === 0) return false; // only added lines: a new statement
  const newRanges = hunks.filter((h) => h.newLines > 0).map((h) => [h.newStart, h.newStart + h.newLines - 1] as const);
  const own = names(ref);
  if (own === undefined) return false;
  const oldPath = file.oldPath ?? file.path;
  const [oldText, newText] = [await readSide.from(oldPath), await readSide.to(file.path)];
  if (oldText === undefined || newText === undefined) return false;
  const before = statementsIn(ctx, oldPath, oldText, ref, own, oldRanges);
  const after = statementsIn(ctx, file.path, newText, ref, own, newRanges);
  const only = before.length === 1 && after.length === 1 ? before[0] : undefined;
  if (only === undefined || only.specifier === after[0]?.specifier || !(only.specifier.startsWith("./") || only.specifier.startsWith("../"))) return false;
  const candidates = resolutionCandidates(oldPath, only.specifier);
  if (candidates === undefined) return false;
  const sources: GitBlobSource[] = [from === "HEAD" || from === "INDEX" ? from : { commit: from.commit }];
  if (ctx.baselineHeadOid !== undefined) sources.push({ commit: ctx.baselineHeadOid });
  for (const s of sources) if (await existsIn(ctx, s, candidates)) return false;
  return true;
}
