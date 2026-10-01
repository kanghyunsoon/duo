/**
 * Shared collector of structural facts for the Java, C#, C++ and Python extractors (T18.0). Same
 * contract as the TypeScript extractor: declarations with the same identity become one symbol (the
 * first one with a body is primary, the others are additionalLocations; an extractor may name the
 * effective one instead, Python T24.4), member identity is
 * "Type.name" (instance) or "Type.static.name", nothing is resolved, and nothing is built from a
 * declaration whose own fields sit next to an ERROR node.
 */
import { compareSourceLocations, symbolRef, type Diagnostic, type RepoPath, type SourceLocation, type SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import { parseDuoAnnotations } from "../annotations.js";
import type {
  AnalyzedSymbol, AnalyzedTest, CallableDeclaration, CallSite, CallSiteKind, DuoAnnotation, ImportBinding, MemberScope, ModuleReference, ModuleReferenceKind,
  ModuleReferenceSyntax, SymbolKind, TestConfidence, TestFrameworkHint,
} from "../types.js";
import { compact, location, parseErrors, reportParseErrors, sortExtraction, type Extraction } from "./syntax.js";

/** Member identity: "C.m" (instance), "C.static.m" (static). */
export function memberIdentity(owner: string, name: string, scope: MemberScope | undefined): string {
  return scope === "static" ? `${owner}.static.${name}` : `${owner}.${name}`;
}

export interface DeclarationInput {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly memberScope?: MemberScope;
  /** qualifiedName of the containing type or namespace. */
  readonly parent?: string;
  readonly node: Node;
  readonly hasBody: boolean;
  /** C++ callables (T24.3): role and syntactic signature for declaration links. */
  readonly callable?: Omit<CallableDeclaration, "location">;
}

interface Declaration extends Omit<DeclarationInput, "node"> {
  readonly identity: string;
  readonly location: SourceLocation;
}

export class StructuralCollector {
  private readonly declarations: Declaration[] = [];
  /** Identity → the location an extractor proved to be the effective definition (Python, T24.4). */
  private readonly preferred = new Map<string, SourceLocation>();
  readonly moduleReferences: ModuleReference[] = [];
  readonly callSites: CallSite[] = [];
  readonly annotations: DuoAnnotation[] = [];
  readonly tests: AnalyzedTest[] = [];
  readonly diagnostics: Diagnostic[] = [];

  constructor(readonly path: RepoPath) {}

  /** Adds a declaration; returns the symbol ref calls inside it belong to. */
  symbol(d: DeclarationInput): SymbolRef {
    const identity = d.parent === undefined ? d.qualifiedName : memberIdentity(d.parent, d.name, d.memberScope);
    const { node, ...rest } = d;
    this.declarations.push({ ...rest, identity, location: location(this.path, node) });
    return symbolRef(this.path, identity);
  }

  /**
   * The declaration at node becomes the primary location of its Symbol (T24.4, C226). Only an extractor
   * that can show statically which definition is effective calls this; otherwise the first declaration
   * with a body stays primary. The Symbol's identity and set of locations do not change.
   */
  prefer(identity: string, node: Node): void {
    this.preferred.set(identity, location(this.path, node));
  }

  module(node: Node, specifier: string, kind: ModuleReferenceKind, bindings: readonly ImportBinding[], syntax: ModuleReferenceSyntax = {}): void {
    this.moduleReferences.push({
      specifier, kind, typeOnly: false, bindings: [...bindings], reexports: [], ...(Object.keys(syntax).length === 0 ? {} : { syntax }), location: location(this.path, node),
    });
  }

  call(node: Node, kind: CallSiteKind, calleeText: string, calleePath: readonly string[] | undefined, enclosing: SymbolRef | undefined, rootLocal: boolean, mayBeMember = false): void {
    this.callSites.push({
      kind, calleeText: compact(calleeText), ...(calleePath === undefined || calleePath.length === 0 ? {} : { calleePath: [...calleePath] }),
      ...(rootLocal ? { rootLocal: true as const } : {}), ...(mayBeMember ? { mayBeMember: true as const } : {}),
      ...(enclosing === undefined ? {} : { enclosingSymbol: enclosing }), location: location(this.path, node),
    });
  }

  test(node: Node, t: { name: string; suites: readonly string[]; hint: TestFrameworkHint; confidence: TestConfidence; enclosing?: SymbolRef }, end?: Node): void {
    const at = location(this.path, node);
    const loc = end === undefined ? at : { ...at, endLine: end.endPosition.row + 1, endColumn: end.endPosition.column + 1 };
    this.tests.push({
      name: t.name, fullName: [...t.suites, t.name].join(" > "), kind: "test", frameworkHint: t.hint, confidence: t.confidence,
      ...(t.suites.length === 0 ? {} : { enclosingSuite: t.suites.join(" > ") }), ...(t.enclosing === undefined ? {} : { enclosingSymbol: t.enclosing }), location: loc,
    });
  }

  comment(node: Node): void {
    const r = parseDuoAnnotations(this.path, node.text, node.startPosition.row + 1, node.startPosition.column + 1);
    this.annotations.push(...r.annotations);
    this.diagnostics.push(...r.diagnostics);
  }

  private merged(): AnalyzedSymbol[] {
    const groups = new Map<string, Declaration[]>();
    for (const d of this.declarations) groups.set(d.identity, [...(groups.get(d.identity) ?? []), d]);
    const out: AnalyzedSymbol[] = [];
    for (const [identity, group] of groups) {
      const sorted = [...group].sort((a, b) => compareSourceLocations(a.location, b.location));
      const chosen = this.preferred.get(identity);
      const primary = (chosen === undefined ? undefined : sorted.find((d) => compareSourceLocations(d.location, chosen) === 0))
        ?? sorted.find((d) => d.hasBody) ?? (sorted[0] as Declaration);
      const others = sorted.filter((d) => d !== primary).map((d) => d.location);
      const callables = sorted.flatMap((d): CallableDeclaration[] => (d.callable === undefined ? [] : [{ location: d.location, ...d.callable }]));
      out.push({
        ref: symbolRef(this.path, identity), name: primary.name, qualifiedName: primary.qualifiedName, kind: primary.kind, exported: primary.exported,
        ...(primary.memberScope === undefined ? {} : { memberScope: primary.memberScope }), ...(primary.parent === undefined ? {} : { parent: primary.parent }),
        location: primary.location, ...(others.length === 0 ? {} : { additionalLocations: others }),
        ...(callables.length === 0 ? {} : { callables }),
      });
    }
    return out;
  }

  finish(tree: Tree): Extraction {
    const errors = parseErrors(tree);
    const diagnostics = [...this.diagnostics, ...reportParseErrors(this.path, tree, errors)];
    return sortExtraction({
      symbols: this.merged(), moduleReferences: this.moduleReferences, exports: [], callSites: this.callSites, annotations: this.annotations, tests: this.tests, diagnostics,
    }, errors.length > 0 || tree.rootNode.hasError);
  }
}

/** Walks node and its descendants in source order; the visitor returns false to skip the children. */
export function walk(node: Node, visit: (n: Node) => boolean): void {
  if (!visit(node)) return;
  for (const c of node.namedChildren) if (c !== null) walk(c, visit);
}
