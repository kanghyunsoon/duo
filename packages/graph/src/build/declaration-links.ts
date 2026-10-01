/**
 * C++ declaration links (T24.3, C218): a header declaration and its out-of-line definition in a source
 * file, proven by syntax only. Symbols and the Graph do not change; the links are recorded as Graph
 * metadata (key "declaration_links", written in the same transaction as the index state token) for the
 * Context Compiler, which treats linked Symbols as one logical callable.
 *
 * A link needs, for one callable declaration (no body) and one definition (a body):
 *   - the same qualified name (namespace, class, name; spaces removed: "operator ==" is "operator==")
 *   - the same syntactic signature (parameter types as written without names, default values and
 *     comments; cv and ref qualifiers; analyzer CallableDeclaration.signature)
 *   - exactly one declaration and exactly one definition with that key in the whole repository
 *   - the definition's file names the declaration's file in a quoted #include: resolved next to the file
 *     (the C++ L1 include rule), or written as a path that ends exactly one repository file (Unreal
 *     "ActionSystem/X.h", Public/Private). Include search paths and build files are not read; a written
 *     path that ends two files is no evidence. This evidence links only: IMPORTS edges stay L1.
 *   - different files (within one file the declarations are one Symbol already)
 * Names alone, parameter counts, file names and directories never link. Templates, internal linkage,
 * friends and unreadable parameters have no signature and never link. Rebuilt from all analyses on every
 * index, so a link never outlives its evidence.
 */
import type { SourceAnalysis } from "@duo-director/analyzer";
import { compareUtf8, nodeId, type RepoPath } from "@duo-director/core";
import type { GraphReader } from "../store/types.js";
import type { FileResolution } from "./types.js";

export const DECLARATION_LINKS_KEY = "declaration_links";
export const DECLARATION_LINKS_FORMAT = "duo.declaration-links/1";

export interface DeclarationEnd {
  /** Symbol node ID. */
  readonly symbol: string;
  readonly path: RepoPath;
  readonly startLine: number;
}

export interface DeclarationLink {
  readonly declaration: DeclarationEnd;
  readonly definition: DeclarationEnd;
}

const key = (qualifiedName: string, signature: string) => `${qualifiedName.replace(/\s+/gu, "")}\u0000${signature}`;

export function declarationLinks(analyses: readonly SourceAnalysis[], resolution: ReadonlyMap<RepoPath, FileResolution>, files: readonly string[]): DeclarationLink[] {
  const declarations = new Map<string, DeclarationEnd[]>();
  const definitions = new Map<string, DeclarationEnd[]>();
  const includes = new Map<string, Set<string>>();
  // Written include path → the one repository file it ends, if exactly one. Candidates come from a file-name index
  // built once (no scan of every file per include).
  let byName: Map<string, string[]> | undefined;
  const named = (name: string) => {
    if (byName === undefined) {
      byName = new Map();
      for (const p of files) { const n = p.slice(p.lastIndexOf("/") + 1); byName.set(n, [...(byName.get(n) ?? []), p]); }
    }
    return byName.get(name) ?? [];
  };
  const suffixTarget = new Map<string, string | undefined>();
  const endsOne = (written: string): string | undefined => {
    if (suffixTarget.has(written)) return suffixTarget.get(written);
    const hits = named(written.slice(written.lastIndexOf("/") + 1)).filter((p) => p === written || p.endsWith(`/${written}`));
    const one = hits.length === 1 ? hits[0] : undefined;
    suffixTarget.set(written, one);
    return one;
  };
  for (const a of analyses) {
    const modules = resolution.get(a.path)?.modules;
    if (modules !== undefined) {
      const targets = new Set<string>();
      a.moduleReferences.forEach((m, i) => {
        if (m.kind !== "include" || m.syntax?.system === true) return;
        const r = modules[i];
        if (r?.status === "resolved") { targets.add(r.path); return; }
        const written = m.specifier.replace(/^\.\//u, "");
        if (written === "" || written.split("/").some((s) => s === ".." || s === ".")) return;
        const one = endsOne(written);
        if (one !== undefined) targets.add(one);
      });
      includes.set(a.path, targets);
    }
    for (const s of a.symbols) {
      for (const c of s.callables ?? []) {
        if (c.signature === undefined || c.location.startLine === undefined) continue;
        const k = key(s.qualifiedName, c.signature);
        const map = c.role === "declaration" ? declarations : definitions;
        map.set(k, [...(map.get(k) ?? []), { symbol: nodeId(s.ref), path: a.path, startLine: c.location.startLine }]);
      }
    }
  }
  const out: DeclarationLink[] = [];
  for (const [k, decl] of declarations) {
    const def = definitions.get(k);
    // Unique on both sides: one declaration, one definition; otherwise nothing is chosen.
    if (decl.length !== 1 || def?.length !== 1) continue;
    const d = decl[0] as DeclarationEnd;
    const f = def[0] as DeclarationEnd;
    if (d.path === f.path || includes.get(f.path)?.has(d.path) !== true) continue;
    out.push({ declaration: d, definition: f });
  }
  return out.sort((a, b) => compareUtf8(a.declaration.symbol, b.declaration.symbol) || a.declaration.startLine - b.declaration.startLine
    || compareUtf8(a.definition.symbol, b.definition.symbol) || a.definition.startLine - b.definition.startLine);
}

export function declarationLinksMeta(links: readonly DeclarationLink[]): string {
  return JSON.stringify({ format: DECLARATION_LINKS_FORMAT, pairs: links });
}

/**
 * The recorded links, or none: a graph indexed before T24.3, a foreign format or an unreadable value
 * means no link (the Context then behaves as before).
 */
export function readDeclarationLinks(graph: Pick<GraphReader, "readMeta">): DeclarationLink[] {
  const raw = graph.readMeta(DECLARATION_LINKS_KEY);
  if (raw === undefined) return [];
  try {
    const v = JSON.parse(raw) as { format?: unknown; pairs?: unknown };
    if (v.format !== DECLARATION_LINKS_FORMAT || !Array.isArray(v.pairs)) return [];
    const end = (e: unknown): e is DeclarationEnd => typeof e === "object" && e !== null && typeof (e as DeclarationEnd).symbol === "string"
      && typeof (e as DeclarationEnd).path === "string" && Number.isInteger((e as DeclarationEnd).startLine);
    return v.pairs.filter((p): p is DeclarationLink => typeof p === "object" && p !== null && end((p as DeclarationLink).declaration) && end((p as DeclarationLink).definition));
  } catch {
    return [];
  }
}

