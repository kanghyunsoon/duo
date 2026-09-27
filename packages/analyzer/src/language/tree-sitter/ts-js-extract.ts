/**
 * TypeScript / TSX / JavaScript syntax facts from a Tree-sitter tree (TASK-005). The three grammars
 * share the node types used here. Symbols: top-level declarations and class members only; nested
 * functions are not symbols. Nothing is resolved: module specifiers stay literal, call targets stay text.
 * Subtrees under ERROR nodes are not trusted and not read.
 */
import {
  compareSourceLocations, compareUtf8, createDiagnostic, symbolRef,
  type Diagnostic, type RepoPath, type SourceLocation, type SymbolRef,
} from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import { parseDuoAnnotations } from "../annotations.js";
import type {
  AnalyzedSymbol, CallSite, CallSiteKind, DuoAnnotation, ModuleReference, ModuleReferenceKind, SymbolKind,
} from "../types.js";

export interface Extraction {
  readonly symbols: AnalyzedSymbol[];
  readonly moduleReferences: ModuleReference[];
  readonly callSites: CallSite[];
  readonly annotations: DuoAnnotation[];
  readonly diagnostics: Diagnostic[];
  /** The tree has ERROR or MISSING nodes. */
  readonly partial: boolean;
}

/** Most AST_PARSE_ERROR diagnostics reported per file; the rest are summarized in one message. */
const MAX_PARSE_DIAGNOSTICS = 20;

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const ANONYMOUS_DEFAULT_FUNCTIONS = FUNCTION_VALUES;

interface Declaration {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly location: SourceLocation;
  /** False for overload and abstract signatures. */
  readonly hasBody: boolean;
  readonly exported: boolean;
  readonly static: boolean;
  readonly parent?: string;
  /** Node whose calls belong to this symbol. */
  readonly scope?: Node;
}

function location(path: RepoPath, node: Node): SourceLocation {
  return {
    path,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

const hasToken = (node: Node, token: string) => node.children.some((c) => !c.isNamed && c.type === token);
const unwrapParens = (node: Node | null): Node | null => {
  let n = node;
  while (n?.type === "parenthesized_expression") n = n.namedChildren[0] ?? null;
  return n;
};
/** Callee text without line breaks and their indentation ("a\n  .b" → "a.b"). */
const compact = (text: string) => text.replace(/[ \t]*\r?\n[ \t]*/g, "");
/** Inner text of a string literal node, as written. */
const stringValue = (node: Node) => node.text.slice(1, -1);

function memberName(node: Node | null): string | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case "property_identifier":
    case "private_property_identifier":
    case "identifier":
      return node.text;
    case "string":
      return stringValue(node);
    default:
      // computed_property_name ([key]) and numeric names are not stable identities.
      return undefined;
  }
}

class Extractor {
  private readonly declarations: Declaration[] = [];
  private readonly exportedNames = new Set<string>();
  private readonly scopes = new Map<number, SymbolRef>();
  private readonly moduleReferences: ModuleReference[] = [];
  private readonly callSites: CallSite[] = [];
  private readonly annotations: DuoAnnotation[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly errors: { node: Node; missing: boolean }[] = [];

  constructor(private readonly path: RepoPath, private readonly tree: Tree) {}

  run(): Extraction {
    for (const statement of this.tree.rootNode.namedChildren) this.topLevel(statement);
    const symbols = this.mergeDeclarations();
    this.walk();
    const partial = this.errors.length > 0 || this.tree.rootNode.hasError;
    this.reportErrors();
    return {
      symbols,
      moduleReferences: this.moduleReferences.sort((a, b) =>
        compareSourceLocations(a.location, b.location) || compareUtf8(a.specifier, b.specifier) || compareUtf8(a.kind, b.kind)),
      callSites: this.callSites.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.calleeText, b.calleeText)),
      annotations: this.annotations.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.ids.join(","), b.ids.join(","))),
      diagnostics: this.diagnostics,
      partial,
    };
  }

  // ---- symbols ----

  private topLevel(node: Node): void {
    if (node.isError) return;
    if (node.type !== "export_statement") {
      this.declaration(node, false);
      return;
    }
    const declaration = node.childForFieldName("declaration");
    const value = unwrapParens(node.childForFieldName("value"));
    const isDefault = hasToken(node, "default");
    if (declaration !== null) this.declaration(declaration, true);
    else if (value !== null && isDefault) {
      if (ANONYMOUS_DEFAULT_FUNCTIONS.has(value.type)) this.add({ name: "default", qualifiedName: "default", kind: "function", node: value, hasBody: true, exported: true, scope: value });
      else if (value.type === "class") this.classDeclaration(value, "default", true);
      else if (value.type === "identifier") this.exportedNames.add(value.text);
    }
    if (node.childForFieldName("source") === null) {
      for (const clause of node.namedChildren.filter((c) => c.type === "export_clause")) {
        for (const specifier of clause.namedChildren) {
          const local = specifier.childForFieldName("name");
          if (specifier.type === "export_specifier" && local !== null) this.exportedNames.add(local.text);
        }
      }
    }
  }

  private declaration(node: Node, exported: boolean): void {
    if (node.isError) return;
    const name = node.childForFieldName("name");
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
        if (name !== null) this.add({ name: name.text, qualifiedName: name.text, kind: "function", node, hasBody: true, exported, scope: node });
        return;
      case "function_signature":
        if (name !== null) this.add({ name: name.text, qualifiedName: name.text, kind: "function", node, hasBody: false, exported });
        return;
      case "class_declaration":
      case "abstract_class_declaration":
        if (name !== null) this.classDeclaration(node, name.text, exported);
        return;
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const kind: SymbolKind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type-alias";
        if (name !== null) this.add({ name: name.text, qualifiedName: name.text, kind, node, hasBody: true, exported });
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const id = declarator.childForFieldName("name");
          const value = unwrapParens(declarator.childForFieldName("value"));
          // Only function-valued variables are symbols; plain constants are not.
          if (id?.type === "identifier" && value !== null && FUNCTION_VALUES.has(value.type)) {
            this.add({ name: id.text, qualifiedName: id.text, kind: "function", node: declarator, hasBody: true, exported, scope: value });
          }
        }
        return;
      case "ambient_declaration":
        for (const child of node.namedChildren) this.declaration(child, exported);
        return;
      default:
        return;
    }
  }

  private classDeclaration(node: Node, className: string, exported: boolean): void {
    this.add({ name: className, qualifiedName: className, kind: "class", node, hasBody: true, exported, scope: node });
    const body = node.childForFieldName("body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      if (member.isError) continue;
      const signature = member.type === "method_signature" || member.type === "abstract_method_signature";
      if (member.type !== "method_definition" && !signature) continue;
      const name = memberName(member.childForFieldName("name"));
      if (name === undefined) continue;
      const isStatic = hasToken(member, "static");
      const kind: SymbolKind = hasToken(member, "get") ? "getter" : hasToken(member, "set") ? "setter"
        : name === "constructor" && !isStatic ? "constructor" : "method";
      this.add({
        name, qualifiedName: `${className}.${name}`, kind, node: member, hasBody: !signature, exported,
        static: isStatic, parent: className, ...(signature ? {} : { scope: member }),
      });
    }
  }

  private add(d: Omit<Declaration, "location" | "static"> & { node: Node; static?: boolean }): void {
    const { node, ...rest } = d;
    this.declarations.push({ ...rest, static: d.static ?? false, location: location(this.path, node) });
  }

  /** One symbol per qualified name: overloads and merged declarations share it (primary = first with a body). */
  private mergeDeclarations(): AnalyzedSymbol[] {
    const groups = new Map<string, Declaration[]>();
    for (const d of this.declarations) groups.set(d.qualifiedName, [...(groups.get(d.qualifiedName) ?? []), d]);
    const exportedTop = (d: Declaration) => d.exported || this.exportedNames.has(d.name);
    const symbols: AnalyzedSymbol[] = [];
    for (const [qualifiedName, group] of groups) {
      group.sort((a, b) => compareSourceLocations(a.location, b.location));
      const primary = group.find((d) => d.hasBody) ?? group[0];
      if (primary === undefined) continue;
      const kinds = new Set(group.map((d) => d.kind));
      const kind: SymbolKind = kinds.has("getter") && kinds.has("setter") ? "accessor" : primary.kind;
      const parentGroup = primary.parent === undefined ? undefined : groups.get(primary.parent);
      const exported = primary.parent === undefined ? group.some(exportedTop) : (parentGroup ?? []).some(exportedTop);
      const ref = symbolRef(this.path, qualifiedName);
      for (const d of group) if (d.scope !== undefined) this.scopes.set(d.scope.id, ref);
      const others = group.filter((d) => d !== primary).map((d) => d.location);
      symbols.push({
        ref, name: primary.name, qualifiedName, kind, exported,
        ...(primary.static ? { static: true as const } : {}),
        ...(primary.parent === undefined ? {} : { parent: primary.parent }),
        location: primary.location,
        ...(others.length > 0 ? { additionalLocations: others } : {}),
      });
    }
    return symbols.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.qualifiedName, b.qualifiedName));
  }

  // ---- one walk for modules, calls, annotations and errors ----

  private walk(): void {
    const cursor = this.tree.walk();
    const stack: SymbolRef[] = [];
    const enter = (node: Node): boolean => {
      if (node.isError) {
        this.errors.push({ node, missing: false });
        return false;
      }
      if (node.isMissing) {
        this.errors.push({ node, missing: true });
        return false;
      }
      const scope = this.scopes.get(node.id);
      if (scope !== undefined) stack.push(scope);
      this.visit(node, stack.at(-1));
      return true;
    };
    const leave = (node: Node) => {
      if (this.scopes.has(node.id)) stack.pop();
    };
    try {
      let descend = enter(cursor.currentNode);
      for (;;) {
        if (descend && cursor.gotoFirstChild()) {
          descend = enter(cursor.currentNode);
          continue;
        }
        leave(cursor.currentNode);
        let moved = cursor.gotoNextSibling();
        while (!moved) {
          if (!cursor.gotoParent()) return;
          leave(cursor.currentNode);
          moved = cursor.gotoNextSibling();
        }
        descend = enter(cursor.currentNode);
      }
    } finally {
      cursor.delete();
    }
  }

  private visit(node: Node, enclosing: SymbolRef | undefined): void {
    switch (node.type) {
      case "comment": {
        const r = parseDuoAnnotations(this.path, node.text, node.startPosition.row + 1, node.startPosition.column + 1);
        this.annotations.push(...r.annotations);
        this.diagnostics.push(...r.diagnostics);
        return;
      }
      case "import_statement": {
        const source = node.childForFieldName("source");
        const requireClause = node.namedChildren.find((c) => c.type === "import_require_clause");
        const requireSource = requireClause?.childForFieldName("source") ?? null;
        if (source?.type === "string") this.module(node, source, "import", hasToken(node, "type"));
        else if (requireSource?.type === "string") this.module(node, requireSource, "require", false);
        return;
      }
      case "export_statement": {
        const source = node.childForFieldName("source");
        if (source?.type === "string") this.module(node, source, "export-from", hasToken(node, "type"));
        return;
      }
      case "call_expression":
        this.call(node, enclosing);
        return;
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        if (ctor?.type === "identifier" || ctor?.type === "member_expression") this.callSite("constructor", ctor, node, enclosing);
        return;
      }
      default:
        return;
    }
  }

  private call(node: Node, enclosing: SymbolRef | undefined): void {
    const fn = node.childForFieldName("function");
    if (fn === null) return;
    const args = node.childForFieldName("arguments");
    const only = args?.type === "arguments" && args.namedChildren.length === 1 ? args.namedChildren[0] : undefined;
    if (fn.type === "import") {
      if (only?.type === "string") this.module(node, only, "dynamic-import", false);
      return;
    }
    if (fn.type === "identifier" && fn.text === "require" && only?.type === "string") {
      this.module(node, only, "require", false);
      return;
    }
    let kind: CallSiteKind | undefined;
    if (fn.type === "identifier" || fn.type === "super") kind = "identifier";
    else if (fn.type === "member_expression" || fn.type === "subscript_expression") kind = "member";
    // Other callees (f()(), (a || b)(), IIFEs) are not recorded: there is no name to report.
    if (kind !== undefined) this.callSite(kind, fn, node, enclosing);
  }

  private callSite(kind: CallSiteKind, callee: Node, node: Node, enclosing: SymbolRef | undefined): void {
    this.callSites.push({
      kind, calleeText: compact(callee.text), ...(enclosing === undefined ? {} : { enclosingSymbol: enclosing }), location: location(this.path, node),
    });
  }

  private module(statement: Node, specifier: Node, kind: ModuleReferenceKind, typeOnly: boolean): void {
    this.moduleReferences.push({ specifier: stringValue(specifier), kind, typeOnly, location: location(this.path, statement) });
  }

  private reportErrors(): void {
    const sorted = this.errors
      .map((e) => ({ ...e, location: location(this.path, e.node) }))
      .sort((a, b) => compareSourceLocations(a.location, b.location));
    for (const e of sorted.slice(0, MAX_PARSE_DIAGNOSTICS)) {
      this.diagnostics.push(createDiagnostic("AST_PARSE_ERROR", e.missing ? `Syntax error: missing "${e.node.type}"` : "Syntax error", e.location));
    }
    if (sorted.length > MAX_PARSE_DIAGNOSTICS) {
      const first = sorted[MAX_PARSE_DIAGNOSTICS];
      this.diagnostics.push(createDiagnostic("AST_PARSE_ERROR", `${sorted.length - MAX_PARSE_DIAGNOSTICS} more syntax errors`, first?.location));
    }
    if (sorted.length === 0 && this.tree.rootNode.hasError) {
      this.diagnostics.push(createDiagnostic("AST_PARSE_ERROR", "Syntax error", { path: this.path }));
    }
  }
}

export function extractTypeScriptJavaScript(path: RepoPath, tree: Tree): Extraction {
  return new Extractor(path, tree).run();
}
