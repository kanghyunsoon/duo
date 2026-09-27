/**
 * TypeScript / TSX / JavaScript syntax facts from a Tree-sitter tree (TASK-005, T05.1). The three
 * grammars share the node types used here. Symbols: top-level declarations and class members only;
 * nested functions are not symbols. Nothing is resolved: module specifiers stay literal, call
 * targets stay text, tests are calls with literal names. Subtrees under ERROR nodes are not read.
 */
import {
  compareSourceLocations, compareUtf8, createDiagnostic, symbolRef,
  type Diagnostic, type RepoPath, type SourceLocation, type SymbolRef,
} from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import { parseDuoAnnotations } from "../annotations.js";
import type {
  AnalyzedSymbol, AnalyzedTest, CallSite, CallSiteKind, DuoAnnotation, ImportBinding, MemberScope, ModuleReference,
  ModuleReferenceKind, ReExportBinding, SymbolKind, TestConfidence, TestFrameworkHint, TestKind, TestModifier,
} from "../types.js";

export interface Extraction {
  readonly symbols: AnalyzedSymbol[];
  readonly moduleReferences: ModuleReference[];
  readonly callSites: CallSite[];
  readonly annotations: DuoAnnotation[];
  readonly tests: AnalyzedTest[];
  readonly diagnostics: Diagnostic[];
  /** The tree has ERROR or MISSING nodes. */
  readonly partial: boolean;
}

/** Most AST_PARSE_ERROR diagnostics reported per file; the rest are summarized in one message. */
const MAX_PARSE_DIAGNOSTICS = 20;

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/** Test framework modules and the exports that declare tests (explicit confidence). */
const TEST_FRAMEWORKS: Readonly<Record<string, { hint: TestFrameworkHint; exports: Readonly<Record<string, TestKind>>; defaultKind?: TestKind }>> = {
  vitest: { hint: "vitest", exports: { test: "test", it: "test", describe: "suite", suite: "suite" } },
  "@jest/globals": { hint: "jest", exports: { test: "test", it: "test", describe: "suite" } },
  "node:test": { hint: "node-test", exports: { test: "test", it: "test", describe: "suite", suite: "suite" }, defaultKind: "test" },
};
/** Globals recognized only in test files (heuristic confidence). */
const GLOBAL_TEST_FUNCTIONS: Readonly<Record<string, TestKind>> = { test: "test", it: "test", describe: "suite", suite: "suite" };
const TEST_MODIFIERS = new Set<TestModifier>(["skip", "only", "todo"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

interface Declaration {
  readonly name: string;
  /** Display name. */
  readonly qualifiedName: string;
  /** Identity (SymbolRef.symbol). */
  readonly identity: string;
  readonly kind: SymbolKind;
  readonly location: SourceLocation;
  /** False for overload and abstract signatures. */
  readonly hasBody: boolean;
  readonly exported: boolean;
  readonly memberScope?: MemberScope;
  readonly parent?: string;
  /** Node whose calls belong to this symbol. */
  readonly scope?: Node;
}

/** How a local name refers to a test function. */
interface TestBinding {
  readonly hint: TestFrameworkHint;
  /** undefined: a namespace import of the framework (ns.it). */
  readonly kind?: TestKind;
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
/** A string literal or a template literal without substitutions; undefined for anything computed. */
function literalText(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "string") return stringValue(node);
  if (node.type === "template_string" && !node.namedChildren.some((c) => c.type === "template_substitution")) return node.text.slice(1, -1);
  return undefined;
}
/** Name of an import/export specifier part: identifier text or the value of a string name. */
const specifierName = (node: Node | null) => (node === null ? undefined : node.type === "string" ? stringValue(node) : node.text);

function memberName(node: Node | null): { name: string; identifier: boolean } | undefined {
  if (node === null) return undefined;
  switch (node.type) {
    case "property_identifier":
    case "private_property_identifier":
    case "identifier":
      return { name: node.text, identifier: true };
    case "string": {
      const name = stringValue(node);
      return { name, identifier: IDENTIFIER.test(name) };
    }
    default:
      // computed_property_name ([key]) and numeric names are not stable identities.
      return undefined;
  }
}

/** Member identity: "C.m" (instance), "C.static.m" (static); non-identifier names quoted: 'C["a.b"]'. */
function memberIdentity(className: string, name: string, identifier: boolean, scope: MemberScope): string {
  const segment = identifier ? `.${name}` : `[${JSON.stringify(name)}]`;
  return scope === "static" ? `${className}.static${segment}` : `${className}${segment}`;
}

class Extractor {
  private readonly declarations: Declaration[] = [];
  private readonly exportedNames = new Set<string>();
  private readonly scopes = new Map<number, SymbolRef>();
  private readonly moduleReferences: ModuleReference[] = [];
  private readonly callSites: CallSite[] = [];
  private readonly annotations: DuoAnnotation[] = [];
  private readonly tests: AnalyzedTest[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly errors: { node: Node; missing: boolean }[] = [];
  private readonly testBindings = new Map<string, TestBinding>();
  /** Local names bound by imports or declarations: a global test function name bound here is not a test function. */
  private readonly localNames = new Set<string>();
  private readonly testFile: boolean;

  constructor(private readonly path: RepoPath, private readonly tree: Tree) {
    this.testFile = TEST_FILE.test(path);
  }

  run(): Extraction {
    for (const statement of this.tree.rootNode.namedChildren) this.topLevel(statement);
    const symbols = this.mergeDeclarations();
    this.collectTestBindings();
    this.walk();
    const partial = this.errors.length > 0 || this.tree.rootNode.hasError;
    this.reportErrors();
    return {
      symbols,
      moduleReferences: this.moduleReferences.sort((a, b) =>
        compareSourceLocations(a.location, b.location) || compareUtf8(a.specifier, b.specifier) || compareUtf8(a.kind, b.kind)),
      callSites: this.callSites.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.calleeText, b.calleeText)),
      annotations: this.annotations.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.ids.join(","), b.ids.join(","))),
      tests: this.tests.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.fullName, b.fullName)),
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
      if (FUNCTION_VALUES.has(value.type)) this.add({ name: "default", qualifiedName: "default", identity: "default", kind: "function", node: value, hasBody: true, exported: true, scope: value });
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
    const top = (n: string, kind: SymbolKind, hasBody: boolean, scope?: Node) =>
      this.add({ name: n, qualifiedName: n, identity: n, kind, node, hasBody, exported, ...(scope === undefined ? {} : { scope }) });
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
        if (name !== null) top(name.text, "function", true, node);
        return;
      case "function_signature":
        if (name !== null) top(name.text, "function", false);
        return;
      case "class_declaration":
      case "abstract_class_declaration":
        if (name !== null) this.classDeclaration(node, name.text, exported);
        return;
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const kind: SymbolKind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type-alias";
        if (name !== null) top(name.text, kind, true);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration":
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const id = declarator.childForFieldName("name");
          if (id?.type === "identifier") this.localNames.add(id.text);
          const value = unwrapParens(declarator.childForFieldName("value"));
          // Only function-valued variables are symbols; plain constants are not.
          if (id?.type === "identifier" && value !== null && FUNCTION_VALUES.has(value.type)) {
            this.add({ name: id.text, qualifiedName: id.text, identity: id.text, kind: "function", node: declarator, hasBody: true, exported, scope: value });
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
    this.add({ name: className, qualifiedName: className, identity: className, kind: "class", node, hasBody: true, exported, scope: node });
    const body = node.childForFieldName("body");
    if (body === null) return;
    for (const member of body.namedChildren) {
      if (member.isError) continue;
      const signature = member.type === "method_signature" || member.type === "abstract_method_signature";
      if (member.type !== "method_definition" && !signature) continue;
      const named = memberName(member.childForFieldName("name"));
      if (named === undefined) continue;
      const memberScope: MemberScope = hasToken(member, "static") ? "static" : "instance";
      const kind: SymbolKind = hasToken(member, "get") ? "getter" : hasToken(member, "set") ? "setter"
        : named.name === "constructor" && memberScope === "instance" ? "constructor" : "method";
      this.add({
        name: named.name, qualifiedName: `${className}.${named.name}`, identity: memberIdentity(className, named.name, named.identifier, memberScope),
        kind, node: member, hasBody: !signature, exported, memberScope, parent: className, ...(signature ? {} : { scope: member }),
      });
    }
  }

  private add(d: Omit<Declaration, "location"> & { node: Node }): void {
    const { node, ...rest } = d;
    if (d.parent === undefined) this.localNames.add(d.name);
    this.declarations.push({ ...rest, location: location(this.path, node) });
  }

  /** One symbol per identity: overloads and merged declarations share it (primary = first with a body). */
  private mergeDeclarations(): AnalyzedSymbol[] {
    const groups = new Map<string, Declaration[]>();
    for (const d of this.declarations) groups.set(d.identity, [...(groups.get(d.identity) ?? []), d]);
    const exportedTop = (d: Declaration) => d.exported || this.exportedNames.has(d.name);
    const symbols: AnalyzedSymbol[] = [];
    for (const [identity, group] of groups) {
      group.sort((a, b) => compareSourceLocations(a.location, b.location));
      const primary = group.find((d) => d.hasBody) ?? group[0];
      if (primary === undefined) continue;
      const kinds = new Set(group.map((d) => d.kind));
      const kind: SymbolKind = kinds.has("getter") && kinds.has("setter") ? "accessor" : primary.kind;
      const parentGroup = primary.parent === undefined ? undefined : groups.get(primary.parent);
      const exported = primary.parent === undefined ? group.some(exportedTop) : (parentGroup ?? []).some(exportedTop);
      const ref = symbolRef(this.path, identity);
      for (const d of group) if (d.scope !== undefined) this.scopes.set(d.scope.id, ref);
      const others = group.filter((d) => d !== primary).map((d) => d.location);
      symbols.push({
        ref, name: primary.name, qualifiedName: primary.qualifiedName, kind, exported,
        ...(primary.memberScope === undefined ? {} : { memberScope: primary.memberScope }),
        ...(primary.parent === undefined ? {} : { parent: primary.parent }),
        location: primary.location,
        ...(others.length > 0 ? { additionalLocations: others } : {}),
      });
    }
    return symbols.sort((a, b) => compareSourceLocations(a.location, b.location) || compareUtf8(a.ref.symbol, b.ref.symbol));
  }

  // ---- imports ----

  /** Bindings of an import statement (ESM, and TS import x = require()). */
  private importBindings(statement: Node): ImportBinding[] {
    const statementType = hasToken(statement, "type");
    const out: ImportBinding[] = [];
    const clause = statement.namedChildren.find((c) => c.type === "import_clause");
    for (const part of clause?.namedChildren ?? []) {
      if (part.type === "identifier") out.push({ local: part.text, imported: "default", typeOnly: statementType });
      else if (part.type === "namespace_import") {
        const local = part.namedChildren.find((c) => c.type === "identifier");
        if (local !== undefined) out.push({ local: local.text, imported: "*", typeOnly: statementType });
      } else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const imported = specifierName(spec.childForFieldName("name"));
          const local = specifierName(spec.childForFieldName("alias")) ?? imported;
          if (imported !== undefined && local !== undefined) out.push({ local, imported, typeOnly: statementType || hasToken(spec, "type") });
        }
      }
    }
    const requireClause = statement.namedChildren.find((c) => c.type === "import_require_clause");
    const requireLocal = requireClause?.namedChildren.find((c) => c.type === "identifier");
    if (requireLocal !== undefined) out.push({ local: requireLocal.text, imported: "*", typeOnly: statementType });
    return out;
  }

  /** Bindings of const x = require("m") and const { a, b: c } = require("m"). Other patterns bind nothing here. */
  private requireBindings(call: Node): ImportBinding[] {
    const declarator = call.parent;
    if (declarator?.type !== "variable_declarator" || declarator.childForFieldName("value")?.id !== call.id) return [];
    const pattern = declarator.childForFieldName("name");
    if (pattern?.type === "identifier") return [{ local: pattern.text, imported: "*", typeOnly: false }];
    if (pattern?.type !== "object_pattern") return [];
    const out: ImportBinding[] = [];
    for (const prop of pattern.namedChildren) {
      if (prop.type === "shorthand_property_identifier_pattern") out.push({ local: prop.text, imported: prop.text, typeOnly: false });
      else if (prop.type === "pair_pattern") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const imported = key === null ? undefined : key.type === "string" ? stringValue(key) : key.type === "property_identifier" ? key.text : undefined;
        if (imported !== undefined && value?.type === "identifier") out.push({ local: value.text, imported, typeOnly: false });
      }
    }
    return out;
  }

  private reexports(statement: Node, typeOnly: boolean): ReExportBinding[] {
    const out: ReExportBinding[] = [];
    for (const part of statement.namedChildren) {
      if (part.type === "export_clause") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "export_specifier") continue;
          const imported = specifierName(spec.childForFieldName("name"));
          const exported = specifierName(spec.childForFieldName("alias")) ?? imported;
          if (imported !== undefined && exported !== undefined) out.push({ exported, imported, typeOnly: typeOnly || hasToken(spec, "type") });
        }
      } else if (part.type === "namespace_export") {
        const name = part.namedChildren.find((c) => c.type === "identifier" || c.type === "string");
        const exported = specifierName(name ?? null);
        if (exported !== undefined) out.push({ exported, imported: "*", typeOnly });
      }
    }
    if (out.length === 0 && hasToken(statement, "*")) out.push({ exported: "*", imported: "*", typeOnly });
    return out;
  }

  /** Local names that refer to test functions of vitest, @jest/globals or node:test (explicit). */
  private collectTestBindings(): void {
    for (const statement of this.tree.rootNode.namedChildren) {
      if (statement.type !== "import_statement") continue;
      const source = statement.childForFieldName("source");
      const framework = source?.type === "string" ? TEST_FRAMEWORKS[stringValue(source)] : undefined;
      for (const b of this.importBindings(statement)) {
        if (b.typeOnly) continue;
        if (framework === undefined) {
          this.localNames.add(b.local);
          continue;
        }
        const kind = b.imported === "default" ? framework.defaultKind : framework.exports[b.imported];
        if (b.imported === "*") this.testBindings.set(b.local, { hint: framework.hint });
        else if (kind !== undefined) this.testBindings.set(b.local, { hint: framework.hint, kind });
      }
    }
  }

  // ---- one walk for modules, calls, tests, annotations and errors ----

  private walk(): void {
    const cursor = this.tree.walk();
    const symbolStack: SymbolRef[] = [];
    const suiteStack: { id: number; fullName: string }[] = [];
    let dynamicSuites = 0;
    const dynamicSuiteIds = new Set<number>();
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
      if (scope !== undefined) symbolStack.push(scope);
      const enclosing = symbolStack.at(-1);
      this.visit(node, enclosing);
      if (node.type === "call_expression") {
        const test = this.testCall(node);
        if (test === "dynamic") {
          this.diagnostics.push(createDiagnostic("TEST_NAME_DYNAMIC", "Test or suite name is not a literal; it is not recorded", location(this.path, node)));
          dynamicSuites++;
          dynamicSuiteIds.add(node.id);
        } else if (test !== undefined && dynamicSuites === 0) {
          const parent = suiteStack.at(-1)?.fullName;
          const fullName = parent === undefined ? test.name : `${parent} > ${test.name}`;
          this.tests.push({
            name: test.name, fullName, kind: test.kind, frameworkHint: test.hint, confidence: test.confidence,
            ...(test.modifier === undefined ? {} : { modifier: test.modifier }),
            ...(parent === undefined ? {} : { enclosingSuite: parent }),
            ...(enclosing === undefined ? {} : { enclosingSymbol: enclosing }),
            location: location(this.path, node),
          });
          if (test.kind === "suite") suiteStack.push({ id: node.id, fullName });
        }
      }
      return true;
    };
    const leave = (node: Node) => {
      if (this.scopes.has(node.id)) symbolStack.pop();
      if (suiteStack.at(-1)?.id === node.id) suiteStack.pop();
      if (dynamicSuiteIds.delete(node.id)) dynamicSuites--;
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

  /**
   * A test/suite call: test("n"), it.skip("n"), describe("n"), vt.it("n"), ... "dynamic" when the
   * callee is a test function but the name is not a literal; undefined when it is not a test call.
   */
  private testCall(node: Node):
    | { name: string; kind: TestKind; hint: TestFrameworkHint; confidence: TestConfidence; modifier?: TestModifier }
    | "dynamic" | undefined {
    const fn = node.childForFieldName("function");
    if (fn === null) return undefined;
    let base: Node = fn;
    let modifier: TestModifier | undefined;
    if (fn.type === "member_expression") {
      const property = fn.childForFieldName("property")?.text;
      const object = fn.childForFieldName("object");
      if (object !== null && property !== undefined && TEST_MODIFIERS.has(property as TestModifier)) {
        base = object;
        modifier = property as TestModifier;
      }
    }
    let resolved: { kind: TestKind; hint: TestFrameworkHint; confidence: TestConfidence } | undefined;
    if (base.type === "identifier") {
      const binding = this.testBindings.get(base.text);
      const globalKind = GLOBAL_TEST_FUNCTIONS[base.text];
      if (binding?.kind !== undefined) resolved = { kind: binding.kind, hint: binding.hint, confidence: "explicit" };
      else if (binding === undefined && globalKind !== undefined && this.testFile && !this.localNames.has(base.text)) {
        resolved = { kind: globalKind, hint: "unknown", confidence: "heuristic" };
      }
    } else if (base.type === "member_expression") {
      // Namespace import: import * as vt from "vitest"; vt.it("n").
      const ns = base.childForFieldName("object");
      const member = base.childForFieldName("property")?.text;
      const binding = ns?.type === "identifier" ? this.testBindings.get(ns.text) : undefined;
      const framework = binding !== undefined && binding.kind === undefined
        ? Object.values(TEST_FRAMEWORKS).find((f) => f.hint === binding.hint) : undefined;
      const kind = member === undefined ? undefined : framework?.exports[member];
      if (binding !== undefined && kind !== undefined) resolved = { kind, hint: binding.hint, confidence: "explicit" };
    }
    if (resolved === undefined) return undefined;
    const args = node.childForFieldName("arguments");
    const name = args?.type === "arguments" ? literalText(args.namedChildren[0]) : undefined;
    if (name === undefined) return "dynamic";
    return { name, ...resolved, ...(modifier === undefined ? {} : { modifier }) };
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
        const bindings = this.importBindings(node);
        if (source?.type === "string") this.module(node, source, "import", hasToken(node, "type"), bindings);
        else if (requireSource?.type === "string") this.module(node, requireSource, "require", false, bindings);
        return;
      }
      case "export_statement": {
        const source = node.childForFieldName("source");
        const typeOnly = hasToken(node, "type");
        if (source?.type === "string") this.module(node, source, "export-from", typeOnly, [], this.reexports(node, typeOnly));
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
      if (only?.type === "string") this.module(node, only, "dynamic-import", false, []);
      return;
    }
    if (fn.type === "identifier" && fn.text === "require" && only?.type === "string") {
      this.module(node, only, "require", false, this.requireBindings(node));
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

  private module(statement: Node, specifier: Node, kind: ModuleReferenceKind, typeOnly: boolean, bindings: ImportBinding[], reexports: ReExportBinding[] = []): void {
    this.moduleReferences.push({ specifier: stringValue(specifier), kind, typeOnly, bindings, reexports, location: location(this.path, statement) });
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
