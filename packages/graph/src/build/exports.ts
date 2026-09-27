/**
 * Minimal per-module export index for CALLS resolution (TASK-007). Only what T05 syntax facts show:
 * local exports, explicit re-exports and "export *" chains, bounded by MAX_REEXPORT_DEPTH and a
 * visited set. This is not a TypeScript symbol system.
 */
import type { AnalyzedSymbol, ModuleReference, SourceAnalysis } from "@duo-director/analyzer";
import { nodeId, type RepoPath } from "@duo-director/core";
import type { ModuleResolution } from "./resolve/module-resolver.js";

/** Longest re-export chain followed; deeper chains are unresolved. */
export const MAX_REEXPORT_DEPTH = 4;

export type ExportLookup =
  | { readonly status: "symbol"; readonly file: RepoPath; readonly symbol: AnalyzedSymbol }
  | { readonly status: "not-symbol" | "ambiguous" | "unresolved" };

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

export class ExportIndex {
  private readonly cache = new Map<string, ExportLookup>();

  constructor(
    private readonly analyses: ReadonlyMap<RepoPath, SourceAnalysis>,
    private readonly resolve: (from: RepoPath, ref: ModuleReference) => ModuleResolution,
  ) {}

  /** What "import { name } from file" (or default when name is "default") refers to. */
  lookup(file: RepoPath, name: string): ExportLookup {
    const key = `${file}\u0000${name}`;
    let result = this.cache.get(key);
    if (result === undefined) {
      result = this.find(file, name, 0, new Set());
      this.cache.set(key, result);
    }
    return result;
  }

  private target(from: RepoPath, ref: ModuleReference): RepoPath | undefined {
    const r = this.resolve(from, ref);
    return r.status === "resolved" ? r.path : undefined;
  }

  private find(file: RepoPath, name: string, depth: number, visited: Set<string>): ExportLookup {
    const key = `${file}\u0000${name}`;
    if (depth > MAX_REEXPORT_DEPTH || visited.has(key)) return { status: "unresolved" };
    visited.add(key);
    const analysis = this.analyses.get(file);
    if (analysis === undefined) return { status: "unresolved" };

    // 1. Local exports: export function f / export default X / export { a as b }.
    const locals = [...new Set(analysis.exports.filter((e) => e.exported === name && !e.typeOnly).map((e) => e.local ?? "\u0000none"))];
    if (locals.length > 1) return { status: "ambiguous" };
    const local = locals[0];
    if (local !== undefined) {
      if (local === "\u0000none") return { status: "not-symbol" };
      const symbol = analysis.symbols.find((s) => s.parent === undefined && s.ref.symbol === local);
      if (symbol !== undefined) return { status: "symbol", file, symbol };
      // import { x } from "./a"; export { x };
      for (const ref of analysis.moduleReferences) {
        const binding = ref.bindings.find((b) => b.local === local && !b.typeOnly);
        if (binding === undefined) continue;
        const target = ref.kind === "import" && binding.imported !== "*" ? this.target(file, ref) : undefined;
        return target === undefined ? { status: "unresolved" } : this.find(target, binding.imported, depth + 1, visited);
      }
      return { status: "not-symbol" };
    }

    // 2. Explicit re-exports: export { a as b } from "./m".
    const explicit = analysis.moduleReferences.flatMap((ref) => ref.reexports.filter((r) => r.exported === name && r.exported !== "*" && !r.typeOnly).map((r) => ({ ref, r })));
    if (explicit.length > 1) return { status: "ambiguous" };
    const only = explicit[0];
    if (only !== undefined) {
      if (only.r.imported === "*") return { status: "not-symbol" };
      const target = this.target(file, only.ref);
      return target === undefined ? { status: "unresolved" } : this.find(target, only.r.imported, depth + 1, visited);
    }

    // 3. export * from "./m" (never forwards "default").
    if (name === "default") return { status: "unresolved" };
    const found = new Map<string, { file: RepoPath; symbol: AnalyzedSymbol }>();
    let ambiguous = false;
    for (const ref of analysis.moduleReferences) {
      if (!ref.reexports.some((r) => r.exported === "*" && !r.typeOnly)) continue;
      const target = this.target(file, ref);
      if (target === undefined) continue;
      const r = this.find(target, name, depth + 1, new Set(visited));
      if (r.status === "symbol") found.set(nodeId(r.symbol.ref), { file: r.file, symbol: r.symbol });
      else if (r.status === "ambiguous") ambiguous = true;
    }
    if (ambiguous) return { status: "ambiguous" };
    const candidates = [...found.values()];
    // Implementation source wins over declaration files; two implementations are ambiguous.
    const implementations = candidates.filter((c) => !DECLARATION_FILE.test(c.file));
    const pick = implementations.length > 0 ? implementations : candidates;
    if (pick.length > 1) return { status: "ambiguous" };
    const chosen = pick[0];
    return chosen === undefined ? { status: "unresolved" } : { status: "symbol", ...chosen };
  }
}
