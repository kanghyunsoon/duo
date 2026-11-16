/**
 * H-99 (#48 P8a): a changed import that now resolves to a forbidden file, when the same statement existed on
 * the from side with another specifier that resolved to no file. DUO then cannot tell whether the importer
 * already reached the forbidden file, so the claim stays but is not BLOCK-eligible.
 *
 * Both revisions and the actual diff are read (H-99 (3)): the from-side text is analyzed with the same
 * analyzer, and "resolved to no file" is shown, not guessed: a relative specifier none of whose resolution
 * candidates exists in the diff base tree or in the Adoption Baseline commit. The pairing is strict: the
 * changed lines hold exactly one statement of the same kind and names on each side; the whole file has no more
 * statements of that kind and names than before (none was added beside the replaced one, whatever its
 * specifier); and no relative reference of any kind, names or spelling still reaches the old module (it is
 * gone, not kept, moved, merged or respelled). A non-relative specifier, a statement with no names, any
 * existing candidate file, or a revision that cannot be read keeps the claim BLOCK-eligible (H-99 (2)).
 */
import path from "node:path";
import type { GitBlobSource } from "@duo-director/analyzer";
import type { RepoPath } from "@duo-director/core";
import type { IndexedModuleReference } from "@duo-director/graph";
import type { RuleContext } from "./claims.js";
import type { ChangedFile, ChangedHunk } from "./types.js";

const encoder = new TextEncoder();
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
/**
 * A JS/TS-family extension in a specifier can name a sibling with another one (`./x.js` → `x.ts`, `x.tsx`, or
 * `x.jsx` with allowJs). Every such sibling is a candidate: more candidates can only keep a claim BLOCK-eligible.
 */
const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

type Statement = {
  readonly typeOnly: boolean;
  readonly bindings: readonly { readonly local: string; readonly imported: string; readonly typeOnly: boolean }[];
  readonly reexports: readonly { readonly exported: string; readonly imported: string; readonly typeOnly: boolean }[];
};

/**
 * What identifies a statement besides its specifier. A named binding is its imported name. A default or
 * namespace binding ("default", "*") says nothing on its own, so its local (or, for a re-export, exported)
 * name is part of it. A bare `export * from` names nothing. Undefined for a statement with no names (a
 * side-effect import, a dynamic import or a bare `export * from`): nothing ties it to a from-side statement,
 * so it is a new statement (H-99 (2)). A type-only binding (`import type { X }` or `import { type X }`, the same
 * thing) is marked, so a type-only import turned into a value import is not the same statement.
 */
const names = (r: Statement): string | undefined => {
  const anonymous = (imported: string) => imported === "default" || imported === "*";
  const type = (typeOnly: boolean) => (typeOnly || r.typeOnly ? "type " : "");
  const parts = [
    ...r.bindings.map((b) => `${type(b.typeOnly)}${anonymous(b.imported) ? `${b.imported} as ${b.local}` : b.imported}`),
    ...r.reexports.filter((x) => x.exported !== "*").map((x) => `${type(x.typeOnly)}${anonymous(x.imported) ? `export ${x.imported} as ${x.exported}` : x.imported}`),
  ];
  return parts.length === 0 ? undefined : parts.sort().join("\u0000");
};

/** Every file a relative specifier written in `from` could resolve to; undefined when it leaves the repository. */
export function resolutionCandidates(from: RepoPath, specifier: string): string[] | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined)) return undefined;
  const base = joined.replace(/\/$/u, "");
  const ext = path.posix.extname(base);
  const stem = base.endsWith(".d.ts") ? base.slice(0, -".d.ts".length) : ext === "" ? base : base.slice(0, -ext.length);
  return [
    base, ...EXTENSIONS.map((e) => `${base}${e}`), ...(SCRIPT_EXTENSIONS.has(ext) ? EXTENSIONS.map((e) => `${stem}${e}`) : []),
    `${base}/package.json`, ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

/**
 * Whether any of `files` exists at `source`, read from the tree or the index (#187), not from blob contents: a partial
 * clone whose blobs cannot be fetched still shows which paths exist. Undefined when that cannot be shown (a commit or
 * tree not in this clone, as in a shallow checkout): that proves nothing, so the claim stays BLOCK-eligible.
 */
async function existsIn(ctx: RuleContext, source: GitBlobSource, files: readonly string[]): Promise<boolean | undefined> {
  const found = await ctx.git.pathsExist(source, files as readonly RepoPath[]);
  return found.value === undefined ? undefined : found.value.size > 0;
}

/** Every module reference in the file, as the analyzer reads it. */
function referencesOf(ctx: RuleContext, file: RepoPath, text: string) {
  return ctx.registry?.analyze({ path: file, content: encoder.encode(text) }).value?.moduleReferences ?? [];
}

const relative = (specifier: string) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
/** Whether a relative specifier written in `file` can name one of `targets` (any spelling: extension, index, .js → .ts). */
const reaches = (file: RepoPath, specifier: string, targets: ReadonlySet<string>) =>
  relative(specifier) && (resolutionCandidates(file, specifier) ?? []).some((c) => targets.has(c));

type Located = { readonly location: { readonly startLine?: number; readonly endLine?: number } };
const inRanges = (r: Located, ranges: readonly (readonly [number, number])[]) => {
  const start = r.location.startLine ?? 0;
  return ranges.some(([a, b]) => start <= b && (r.location.endLine ?? start) >= a);
};

/**
 * The import statement on the changed line replaced a from-side specifier that resolved to no file (H-99 (1)).
 * The pairing is one to one (see the file comment): a second statement on the to side, or the from-side
 * statement still present anywhere in the file, means the diff added a statement, which stays BLOCK-eligible.
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
  const fromAll = referencesOf(ctx, oldPath, oldText);
  const toAll = referencesOf(ctx, file.path, newText);
  const same = (r: (typeof fromAll)[number]) => r.kind === ref.kind && names(r) === own;
  const before = fromAll.filter((r) => same(r) && inRanges(r, oldRanges));
  const after = toAll.filter((r) => same(r) && inRanges(r, newRanges));
  const only = before.length === 1 && after.length === 1 ? before[0] : undefined;
  if (only === undefined || only.specifier === after[0]?.specifier || !relative(only.specifier)) return false;
  // No statement of this kind and names was added anywhere in the file, whatever its specifier.
  if (toAll.filter(same).length > fromAll.filter(same).length) return false;
  const candidates = resolutionCandidates(oldPath, only.specifier);
  if (candidates === undefined) return false;
  const oldModule = new Set(candidates);
  // The old module is gone from the whole file: no relative reference of any kind, names or spelling still reaches it.
  if (toAll.some((r) => reaches(file.path, r.specifier, oldModule))) return false;
  const sources: GitBlobSource[] = [from === "HEAD" || from === "INDEX" ? from : { commit: from.commit }];
  if (ctx.baselineHeadOid !== undefined) sources.push({ commit: ctx.baselineHeadOid });
  for (const s of sources) if ((await existsIn(ctx, s, candidates)) !== false) return false;
  return true;
}
