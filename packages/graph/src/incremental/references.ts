/**
 * Indexed module references (T37, H-72): what the last index run read and resolved for a file's import,
 * export-from, require, dynamic import, using and include statements, as stored, read-only. The
 * statements (kind, specifier, type-only, exact SourceLocation) come from the content-addressed
 * analysis cache and their resolution from the index state, in the same order (FileResolution.modules
 * has one result per SourceAnalysis.moduleReferences entry). Nothing is parsed or resolved again: a
 * reader gets the Indexer's own results or a reason why there are none.
 *
 * Valid only while the index is current (inspectIndex). The caller decides that; this never indexes.
 */
import type { ModuleReferenceKind } from "@duo-director/analyzer";
import type { RepoPath, SourceLocation } from "@duo-director/core";
import type { ModuleResolution } from "../build/resolve/module-resolver.js";
import { readCachedAnalyses, type AnalysisCacheKey } from "./analysis-cache.js";
import { readIndexState, type IndexedFileState } from "./state.js";

export interface IndexedModuleReference {
  readonly kind: ModuleReferenceKind;
  /** As written. */
  readonly specifier: string;
  readonly typeOnly: boolean;
  /** The statement (import/export-from/using/include) or the import()/require() call. */
  readonly location: SourceLocation;
  /** The Indexer's result. resolved + an indexed path is the only exact repository-file target. */
  readonly resolution: ModuleResolution;
  /** resolution.status is resolved and its path is an indexed repository file other than the source file. */
  readonly target?: RepoPath;
}

/**
 * ok: the file's references (possibly none). not-indexed: the path is not in the index state.
 * not-analyzed: no language analyzer for the file (L0) or its analysis failed.
 * unavailable: the index state or the cached analysis cannot be read, or they do not match.
 */
export type IndexedModuleReferences =
  | { readonly status: "ok"; readonly path: RepoPath; readonly language: string; readonly references: readonly IndexedModuleReference[] }
  | { readonly status: "not-indexed" | "not-analyzed" | "unavailable"; readonly path: RepoPath; readonly reason?: string };

/** The indexed module references of each path, in path order of the input. Read-only. */
export async function readIndexedModuleReferences(root: string, paths: readonly RepoPath[]): Promise<IndexedModuleReferences[]> {
  const read = readIndexState(root);
  if (read.state === undefined) return paths.map((path) => ({ status: "unavailable" as const, path, reason: read.problem ?? "index state" }));
  const files = new Map<string, IndexedFileState>(read.state.files.map((f) => [f.path, f] as const));
  const keys: (AnalysisCacheKey | undefined)[] = paths.map((path) => {
    const f = files.get(path);
    return f?.analysis === undefined || f.analysis.status !== "ok" || f.resolution === undefined
      ? undefined : { path, contentHash: f.contentHash, analyzer: f.analysis.analyzer, analyzerIdentity: f.analysis.identity };
  });
  const present = keys.filter((k): k is AnalysisCacheKey => k !== undefined);
  const cached = await readCachedAnalyses(root, present);
  const byPath = new Map(present.map((k, i) => [k.path, cached[i]] as const));
  return paths.map((path, i): IndexedModuleReferences => {
    const f = files.get(path);
    if (f === undefined) return { status: "not-indexed", path };
    if (keys[i] === undefined) return { status: "not-analyzed", path };
    const entry = byPath.get(path);
    const modules = f.resolution?.modules ?? [];
    if (entry === undefined) return { status: "unavailable", path, reason: "analysis cache entry missing" };
    const refs = entry.analysis.moduleReferences;
    if (refs.length !== modules.length) return { status: "unavailable", path, reason: "analysis and resolution do not match" };
    return {
      status: "ok", path, language: entry.analysis.language,
      references: refs.map((r, j) => {
        const resolution = modules[j] as ModuleResolution;
        const target = resolution.status === "resolved" && resolution.path !== path && files.has(resolution.path) ? resolution.path : undefined;
        return { kind: r.kind, specifier: r.specifier, typeOnly: r.typeOnly, location: r.location, resolution, ...(target === undefined ? {} : { target }) };
      }),
    };
  });
}
