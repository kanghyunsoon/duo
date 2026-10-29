/**
 * #49 Stage 2 (H-98, L1-C): the origin file of each name a changed import takes, traced at review time
 * through the indexed `export ... from` references and local exports of the files it reaches. Nothing is
 * parsed, resolved or stored again: the index is read as it is (the caller checks that it is current).
 *
 * A name has an exact origin only when every step is certain: one local export (not an imported binding
 * exported again) or one explicit re-export, or `export *` where exactly one module provides the name. An
 * `export * as ns`, a namespace, side-effect or dynamic import (every name), a module that is not analyzed,
 * an unresolved re-export, a cycle, more than MAX_REEXPORT_DEPTH hops, two providers or a name that is both
 * declared and re-exported is ambiguous: the caller keeps the Stage 1 limitation and makes no claim.
 */
import type { LocalExport } from "@duo-director/analyzer";
import { compareUtf8, type RepoPath } from "@duo-director/core";
import { MAX_REEXPORT_DEPTH, readIndexedModuleReferences, type IndexedModuleReference } from "@duo-director/graph";

/** Names an import takes from its target module: "all" for side-effect, dynamic, namespace and CommonJS-object imports. */
export type ImportedNames = "all" | ReadonlySet<string>;

export function importedNames(ref: IndexedModuleReference): ImportedNames {
  if (ref.kind === "export-from") return ref.reexports.some((r) => r.imported === "*") ? "all" : new Set(ref.reexports.map((r) => r.imported));
  const named = ref.bindings.filter((b) => b.imported !== "*");
  return ref.bindings.length === 0 || named.length < ref.bindings.length ? "all" : new Set(named.map((b) => b.imported));
}

/** One `export ... from` statement on the way from the imported module to the origin. */
export interface OriginHop {
  readonly file: RepoPath;
  readonly ref: IndexedModuleReference;
}

export interface NameOrigin {
  readonly name: string;
  readonly file: RepoPath;
  /** The re-export statements followed, in order; empty when the imported module declares the name itself. */
  readonly chain: readonly OriginHop[];
}

/** exact: every name the import takes has one origin (a name no module provides has none and is left out). */
export type OriginTrace = { readonly status: "exact"; readonly origins: readonly NameOrigin[] } | { readonly status: "ambiguous" };

type Find = { readonly status: "exact"; readonly file: RepoPath; readonly chain: readonly OriginHop[] } | { readonly status: "none" | "ambiguous" };
const AMBIGUOUS: Find = { status: "ambiguous" };
const NONE: Find = { status: "none" };

interface Module {
  readonly references: readonly IndexedModuleReference[];
  readonly exports: readonly LocalExport[];
}

export class ReexportOrigins {
  private readonly modules = new Map<RepoPath, Module | undefined>();

  /** excluded: files whose indexed analysis does not describe the side being evaluated (treated as not analyzed). */
  constructor(private readonly root: string, private readonly excluded: ReadonlySet<string> = new Set()) {}

  /** Reads the given files and every module their re-exports reach within MAX_REEXPORT_DEPTH hops. */
  async load(files: readonly RepoPath[]): Promise<void> {
    let frontier = [...new Set(files)];
    for (let hop = 0; hop <= MAX_REEXPORT_DEPTH && frontier.length > 0; hop++) {
      const need = frontier.filter((p) => !this.modules.has(p)).sort(compareUtf8);
      const read = await readIndexedModuleReferences(this.root, need);
      read.forEach((r, i) => this.modules.set(need[i] as RepoPath, r.status === "ok" && !this.excluded.has(r.path) ? { references: r.references, exports: r.exports } : undefined));
      frontier = [...new Set(need.flatMap((p) => this.modules.get(p)?.references.filter((r) => r.kind === "export-from" && r.target !== undefined).map((r) => r.target as RepoPath) ?? []))];
    }
  }

  /** The origin of each name an import of `target` takes. Call load() with `target` first. */
  trace(target: RepoPath, names: ImportedNames): OriginTrace {
    if (names === "all") return { status: "ambiguous" };
    const origins: NameOrigin[] = [];
    for (const name of [...names].sort(compareUtf8)) {
      const r = this.find(target, name, 0, new Set());
      if (r.status === "ambiguous") return { status: "ambiguous" };
      if (r.status === "exact") origins.push({ name, file: r.file, chain: r.chain });
    }
    return { status: "exact", origins };
  }

  private find(file: RepoPath, name: string, hop: number, path: ReadonlySet<string>): Find {
    const m = this.modules.get(file);
    const key = `${file}\u0000${name}`;
    if (m === undefined || hop > MAX_REEXPORT_DEPTH || path.has(key)) return AMBIGUOUS;
    const seen = new Set(path).add(key);
    const locals = m.exports.filter((e) => e.exported === name);
    const explicit = m.references.filter((r) => r.kind === "export-from").flatMap((ref) => ref.reexports.filter((x) => x.exported === name && x.exported !== "*").map((x) => ({ ref, x })));
    if (locals.length + explicit.length > 1) return AMBIGUOUS;
    const local = locals[0];
    if (local !== undefined) {
      // import { x } from "./a"; export { x }: the origin is another module, not followed (H-98 (4)).
      const imported = local.local !== undefined && m.references.some((r) => r.bindings.some((b) => b.local === local.local));
      return imported ? AMBIGUOUS : { status: "exact", file, chain: [] };
    }
    const only = explicit[0];
    if (only !== undefined) {
      if (only.x.imported === "*" || only.ref.target === undefined) return AMBIGUOUS; // export * as ns from: a namespace
      const next = this.find(only.ref.target, only.x.imported, hop + 1, seen);
      return next.status === "exact" ? { status: "exact", file: next.file, chain: [{ file, ref: only.ref }, ...next.chain] } : AMBIGUOUS;
    }
    // export * from never forwards "default".
    if (name === "default") return NONE;
    const stars = m.references.filter((r) => r.kind === "export-from" && r.reexports.some((x) => x.exported === "*"));
    const found: { file: RepoPath; chain: readonly OriginHop[] }[] = [];
    for (const ref of stars) {
      if (ref.target === undefined) return AMBIGUOUS;
      const next = this.find(ref.target, name, hop + 1, seen);
      if (next.status === "ambiguous") return AMBIGUOUS;
      if (next.status === "exact") found.push({ file: next.file, chain: [{ file, ref }, ...next.chain] });
    }
    if (new Set(found.map((f) => f.file)).size > 1) return AMBIGUOUS;
    const one = found[0];
    return one === undefined ? NONE : { status: "exact", ...one };
  }
}
