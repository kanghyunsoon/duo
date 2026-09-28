/**
 * Language-neutral helpers for Tree-sitter extractors (T18.0): source locations, parse error
 * reporting, canonical ordering of an Extraction. Extractors of every language share them, so the
 * SourceLocation contract (canonical text, 1-based lines, UTF-16 columns, [start, end)) is one code path.
 */
import { compareSourceLocations, compareUtf8, createDiagnostic, type Diagnostic, type RepoPath, type SourceLocation } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { AnalyzedSymbol, AnalyzedTest, CallSite, DuoAnnotation, LocalExport, ModuleReference } from "../types.js";

export interface Extraction {
  readonly symbols: AnalyzedSymbol[];
  readonly moduleReferences: ModuleReference[];
  readonly exports: LocalExport[];
  readonly callSites: CallSite[];
  readonly annotations: DuoAnnotation[];
  readonly tests: AnalyzedTest[];
  readonly diagnostics: Diagnostic[];
  /** The tree has ERROR or MISSING nodes. */
  readonly partial: boolean;
}

/** Most AST_PARSE_ERROR diagnostics reported per file; the rest are summarized in one message. */
export const MAX_PARSE_DIAGNOSTICS = 20;

export function location(path: RepoPath, node: Node): SourceLocation {
  return {
    path,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

/** Text without line breaks and their indentation ("a\n  .b" → "a.b"). */
export const compact = (text: string) => text.replace(/[ \t]*\r?\n[ \t]*/g, "");

/** A direct ERROR child: the node's own fields may be misparsed, so no symbol is built from it. */
export const hasErrorChild = (node: Node) => node.children.some((c) => c.isError);

/** ERROR and MISSING nodes of the tree, outermost ERROR only. */
export function parseErrors(tree: Tree): { node: Node; missing: boolean }[] {
  const out: { node: Node; missing: boolean }[] = [];
  const visit = (n: Node) => {
    if (n.isError) { out.push({ node: n, missing: false }); return; }
    if (n.isMissing) { out.push({ node: n, missing: true }); return; }
    if (!n.hasError) return;
    for (const c of n.children) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

export function reportParseErrors(path: RepoPath, tree: Tree, errors: readonly { node: Node; missing: boolean }[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sorted = errors.map((e) => ({ ...e, location: location(path, e.node) })).sort((a, b) => compareSourceLocations(a.location, b.location));
  for (const e of sorted.slice(0, MAX_PARSE_DIAGNOSTICS)) {
    diagnostics.push(createDiagnostic("AST_PARSE_ERROR", e.missing ? `Syntax error: missing "${e.node.type}"` : "Syntax error", e.location));
  }
  if (sorted.length > MAX_PARSE_DIAGNOSTICS) {
    diagnostics.push(createDiagnostic("AST_PARSE_ERROR", `${sorted.length - MAX_PARSE_DIAGNOSTICS} more syntax errors`, sorted[MAX_PARSE_DIAGNOSTICS]?.location));
  }
  if (sorted.length === 0 && tree.rootNode.hasError) diagnostics.push(createDiagnostic("AST_PARSE_ERROR", "Syntax error", { path }));
  return diagnostics;
}

/** The Extraction lists in location order with the SourceAnalysis tie-breakers (types.ts). */
export function sortExtraction(x: Omit<Extraction, "partial">, partial: boolean): Extraction {
  return {
    symbols: x.symbols.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.ref.symbol, b.ref.symbol)),
    moduleReferences: x.moduleReferences.sort((a, b) =>
      compareSourceLocations(a.location, b.location) || compareUtf8(a.specifier, b.specifier) || compareUtf8(a.kind, b.kind)),
    exports: x.exports.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.exported, b.exported)),
    callSites: x.callSites.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.calleeText, b.calleeText)),
    annotations: x.annotations.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.ids.join(","), b.ids.join(","))),
    tests: x.tests.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.fullName, b.fullName)),
    diagnostics: x.diagnostics,
    partial,
  };
}
