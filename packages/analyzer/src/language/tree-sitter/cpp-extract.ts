/**
 * C++ structural facts (T18.0, tree-sitter-cpp). Symbols: namespaces, classes, structs, enums, free
 * functions, and methods, constructors and destructors (declared in a class or defined out of line
 * as A::f). Scope segments are joined with "." ("game.APlayer.Jump"). Templates keep their enclosing
 * symbol; specializations are not separate symbols. Macros are not expanded: known Unreal annotation
 * macros are masked (same length, so every location stays exact) before parsing, and anything that
 * still does not parse is not guessed. #include stays as written. Tests: GoogleTest TEST/TEST_F/
 * TEST_P, Catch2 TEST_CASE/SCENARIO, Unreal IMPLEMENT_*_AUTOMATION_TEST, with their include
 * (explicit) or in a test path (heuristic).
 */
import type { RepoPath, SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { SymbolKind, TestConfidence, TestFrameworkHint } from "../types.js";
import { StructuralCollector, walk } from "./structural.js";
import { hasErrorChild, type Extraction } from "./syntax.js";

/** Unreal reflection and export macros that are annotations, not code: masked before parsing. */
const ANNOTATION_MACRO = /\b(?:UCLASS|USTRUCT|UENUM|UINTERFACE|UPROPERTY|UFUNCTION|UPARAM|UMETA|UDELEGATE|GENERATED_BODY|GENERATED_UCLASS_BODY|GENERATED_USTRUCT_BODY|GENERATED_IINTERFACE_BODY|GENERATED_UINTERFACE_BODY)\s*\(/gu;
const EXPORT_MACRO = /\b(class|struct)(\s+)([A-Z][A-Z0-9_]*_API)(?=\s)/gu;
const GTEST = new Set(["TEST", "TEST_F", "TEST_P", "TYPED_TEST", "TYPED_TEST_P"]);
const CATCH2 = new Set(["TEST_CASE", "SCENARIO", "TEST_CASE_METHOD"]);
const UNREAL_TEST = new Set(["IMPLEMENT_SIMPLE_AUTOMATION_TEST", "IMPLEMENT_COMPLEX_AUTOMATION_TEST"]);
const TEST_PATH = /(^|\/)(tests?|Tests?)\/|(_test|_tests|Test|Tests)\.(cpp|cc|cxx)$/u;

const blank = (s: string) => s.replace(/[^\n]/gu, " ");

/** Masks the macros above with spaces of the same length (line breaks kept). */
export function maskCppAnnotationMacros(text: string): string {
  let out = text.replace(EXPORT_MACRO, (_m, kw: string, ws: string, api: string) => `${kw}${ws}${blank(api)}`);
  for (const m of [...out.matchAll(ANNOTATION_MACRO)]) {
    let depth = 0;
    let i = (m.index ?? 0) + m[0].length - 1;
    let quote: string | undefined;
    for (; i < out.length; i++) {
      const ch = out[i];
      if (quote !== undefined) { if (ch === "\\") i++; else if (ch === quote) quote = undefined; continue; }
      if (ch === "\"" || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue; // unbalanced: leave it, the parser reports it
    const start = m.index ?? 0;
    out = out.slice(0, start) + blank(out.slice(start, i + 1)) + out.slice(i + 1);
  }
  return out;
}

interface Scope {
  /** Namespace segments. */
  readonly ns: readonly string[];
  /** Enclosing class chain (names). */
  readonly classes: readonly string[];
}

const qualify = (s: Scope, ...rest: string[]) => [...s.ns, ...s.classes, ...rest].join(".");
const ownerOf = (s: Scope) => (s.ns.length + s.classes.length === 0 ? undefined : qualify(s));

function unwrapDeclarator(node: Node | null): Node | null {
  let n = node;
  while (n !== null && (n.type === "pointer_declarator" || n.type === "reference_declarator" || n.type === "parenthesized_declarator" || n.type === "attributed_declarator")) {
    n = n.childForFieldName("declarator") ?? n.namedChildren.at(-1) ?? null;
  }
  return n;
}

/** Scope segments and the final name of a declarator name (identifier, A::B::f, `A, operator+). */
function nameParts(node: Node): { scope: string[]; name: string; destructor: boolean } | undefined {
  switch (node.type) {
    case "identifier": case "field_identifier": case "operator_name": case "type_identifier":
      return { scope: [], name: node.text, destructor: false };
    case "destructor_name":
      return { scope: [], name: `~${node.namedChildren[0]?.text ?? node.text.replace(/^~\s*/u, "")}`, destructor: true };
    case "template_function":
      return { scope: [], name: node.childForFieldName("name")?.text ?? node.text, destructor: false };
    case "qualified_identifier": {
      const scopeNode = node.childForFieldName("scope");
      const nameNode = node.childForFieldName("name");
      if (nameNode === null) return undefined;
      const inner = nameParts(nameNode);
      if (inner === undefined) return undefined;
      const head = scopeNode === null ? [] : [scopeNode.type === "template_type" ? (scopeNode.childForFieldName("name")?.text ?? scopeNode.text) : scopeNode.text];
      return { scope: [...head, ...inner.scope], name: inner.name, destructor: inner.destructor };
    }
    default:
      return undefined;
  }
}

/** A call's callee as a name path (identifier, a.b, a->b, this->m, ns::f). */
function namePath(node: Node | null): string[] | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier" || node.type === "this" || node.type === "field_identifier") return [node.text];
  if (node.type === "field_expression") {
    const base = namePath(node.childForFieldName("argument"));
    const field = node.childForFieldName("field");
    return base === undefined || field === null ? undefined : [...base, field.text];
  }
  if (node.type === "qualified_identifier") {
    const parts = nameParts(node);
    return parts === undefined ? undefined : [...parts.scope, parts.name];
  }
  if (node.type === "template_function") return [node.childForFieldName("name")?.text ?? node.text];
  return undefined;
}

function stringArgument(args: Node | null, index: number): string | undefined {
  const arg = args?.namedChildren.filter((c) => c !== null && c.type !== "comment")[index];
  if (arg?.type !== "string_literal") return undefined;
  return arg.namedChildren.filter((c) => c?.type === "string_content").map((c) => c?.text ?? "").join("");
}

class CppExtractor {
  private readonly c: StructuralCollector;
  private readonly includes: string[] = [];
  private readonly testPath: boolean;

  constructor(path: RepoPath, private readonly tree: Tree) {
    this.c = new StructuralCollector(path);
    this.testPath = TEST_PATH.test(path);
  }

  run(): Extraction {
    for (const n of this.tree.rootNode.descendantsOfType("preproc_include")) if (n !== null) this.include(n);
    walk(this.tree.rootNode, (n) => this.visit(n, { ns: [], classes: [] }));
    return this.c.finish(this.tree);
  }

  private include(node: Node): void {
    const p = node.childForFieldName("path");
    if (p === null || node.hasError) return;
    if (p.type === "system_lib_string") {
      const spec = p.text.slice(1, -1);
      this.includes.push(spec);
      this.c.module(node, spec, "include", [], { system: true });
    } else if (p.type === "string_literal") {
      const spec = p.namedChildren.filter((c) => c?.type === "string_content").map((c) => c?.text ?? "").join("");
      this.includes.push(spec);
      this.c.module(node, spec, "include", []);
    }
  }

  private confidence(framework: "gtest" | "catch2" | "unreal"): { hint: TestFrameworkHint; confidence: TestConfidence } | undefined {
    const bound = this.includes.some((i) => (framework === "gtest" ? /(^|\/)gtest\/gtest\.h$|(^|\/)gmock\/gmock\.h$/u
      : framework === "catch2" ? /(^|\/)catch2?\/|(^|\/)catch\.hpp$/u : /(^|\/)AutomationTest\.h$/u).test(i));
    const hint: TestFrameworkHint = framework === "gtest" ? "googletest" : framework === "catch2" ? "catch2" : "unreal-automation";
    if (bound) return { hint, confidence: "explicit" };
    return this.testPath ? { hint, confidence: "heuristic" } : undefined;
  }

  /** A function declarator's symbol; undefined when the name is not a plain function name. */
  private functionSymbol(node: Node, declarator: Node, scope: Scope, hasBody: boolean, isStatic: boolean): SymbolRef | undefined {
    const inner = declarator.childForFieldName("declarator");
    const parts = inner === null ? undefined : nameParts(inner);
    if (parts === undefined) return undefined;
    if (parts.scope.length > 0) {
      // Out-of-line definition A::f: a member of A (the scope's kind is not verified from syntax).
      const ownerScope: Scope = { ns: scope.ns, classes: [...scope.classes, ...parts.scope] };
      const owner = qualify(ownerScope);
      const last = parts.scope.at(-1);
      const kind: SymbolKind = parts.destructor ? "destructor" : parts.name === last ? "constructor" : "method";
      return this.c.symbol({ name: parts.name, qualifiedName: `${owner}.${parts.name}`, kind, exported: true, memberScope: "instance", parent: owner, node, hasBody });
    }
    if (scope.classes.length > 0) {
      const cls = scope.classes.at(-1);
      const kind: SymbolKind = parts.destructor ? "destructor" : parts.name === cls ? "constructor" : "method";
      const owner = qualify(scope);
      return this.c.symbol({ name: parts.name, qualifiedName: `${owner}.${parts.name}`, kind, exported: true, memberScope: isStatic ? "static" : "instance", parent: owner, node, hasBody });
    }
    const parent = ownerOf(scope);
    return this.c.symbol({ name: parts.name, qualifiedName: qualify(scope, parts.name), kind: "function", exported: !isStatic, ...(parent === undefined ? {} : { parent }), node, hasBody });
  }

  private visit(node: Node, scope: Scope): boolean {
    if (node.isError) return false;
    switch (node.type) {
      case "comment": this.c.comment(node); return false;
      case "preproc_include": return false;
      case "namespace_definition": {
        const nameNode = node.childForFieldName("name");
        const segments = nameNode === null ? [] : nameNode.text.split("::").map((s) => s.trim()).filter((s) => s !== "");
        const inner: Scope = { ns: [...scope.ns, ...segments], classes: [] };
        if (segments.length > 0 && !hasErrorChild(node)) {
          const parent = ownerOf(scope);
          this.c.symbol({ name: segments.at(-1) as string, qualifiedName: inner.ns.join("."), kind: "namespace", exported: true, ...(parent === undefined ? {} : { parent }), node, hasBody: true });
        }
        const body = node.childForFieldName("body");
        if (body !== null) walk(body, (n) => this.visit(n, inner));
        return false;
      }
      case "class_specifier": case "struct_specifier": case "enum_specifier": {
        const body = node.childForFieldName("body");
        const nameNode = node.childForFieldName("name");
        if (body === null || nameNode === null) return true;
        if (nameNode.type === "template_type" || hasErrorChild(node)) return false; // specialization or misparse: no symbol
        const name = nameNode.text.split("::").at(-1) as string;
        const kind: SymbolKind = node.type === "class_specifier" ? "class" : node.type === "struct_specifier" ? "struct" : "enum";
        const parent = ownerOf(scope);
        this.c.symbol({ name, qualifiedName: qualify(scope, name), kind, exported: true, ...(parent === undefined ? {} : { parent }), node, hasBody: true });
        if (kind !== "enum") walk(body, (n) => this.visit(n, { ns: scope.ns, classes: [...scope.classes, name] }));
        return false;
      }
      case "function_definition": {
        if (hasErrorChild(node)) return false;
        const declarator = unwrapDeclarator(node.childForFieldName("declarator"));
        if (declarator?.type !== "function_declarator") return false;
        const inner = declarator.childForFieldName("declarator");
        const body = node.childForFieldName("body");
        if (inner?.type === "identifier" && GTEST.has(inner.text) && scope.classes.length === 0) {
          const params = declarator.childForFieldName("parameters")?.namedChildren.filter((c) => c?.type === "parameter_declaration").map((c) => c?.text.trim() ?? "") ?? [];
          const test = this.confidence("gtest");
          if (test !== undefined && params.length === 2 && params.every((p) => /^[A-Za-z_]\w*$/u.test(p))) {
            this.c.test(node, { name: params[1] as string, suites: [params[0] as string], ...test });
          }
          if (body !== null) this.calls(body, undefined, false, new Set());
          return false;
        }
        const isStatic = node.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === "static");
        const ref = this.functionSymbol(node, declarator, scope, true, isStatic);
        const member = ref !== undefined && (scope.classes.length > 0 || (inner !== null && inner.type === "qualified_identifier"));
        if (body !== null) this.calls(body, ref, member, this.locals(declarator, body));
        return false;
      }
      case "declaration": case "field_declaration": {
        if (hasErrorChild(node)) return false;
        const isStatic = node.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === "static");
        for (const d of node.childrenForFieldName("declarator")) {
          const fn = unwrapDeclarator(d);
          if (fn?.type === "function_declarator" && fn.childForFieldName("declarator")?.type !== "qualified_identifier") this.functionSymbol(node, fn, scope, false, isStatic);
        }
        const type = node.childForFieldName("type");
        if (type !== null) walk(type, (n) => this.visit(n, scope));
        return false;
      }
      case "expression_statement": {
        // Test macros at namespace scope: TEST_CASE("name") { ... }, IMPLEMENT_SIMPLE_AUTOMATION_TEST(F, "Name", flags).
        const call = node.namedChildren[0];
        const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
        if (call !== null && call !== undefined && fn?.type === "identifier" && scope.classes.length === 0) {
          if (CATCH2.has(fn.text)) {
            const test = this.confidence("catch2");
            const name = stringArgument(call.childForFieldName("arguments"), 0);
            const next = node.nextNamedSibling;
            if (test !== undefined && name !== undefined) this.c.test(node, { name, suites: [], ...test }, next?.type === "compound_statement" ? next : undefined);
          } else if (UNREAL_TEST.has(fn.text)) {
            const test = this.confidence("unreal");
            const name = stringArgument(call.childForFieldName("arguments"), 1);
            if (test !== undefined && name !== undefined) this.c.test(node, { name, suites: [], ...test });
          }
        }
        return false;
      }
      case "compound_statement":
        // A block at namespace scope (the body of a TEST_CASE macro): calls only.
        this.calls(node, undefined, false, new Set());
        return false;
      default:
        return true;
    }
  }

  /** Names a function binds: parameters and local declarations (conservative: any block). */
  private locals(declarator: Node, body: Node): Set<string> {
    const names = new Set<string>();
    const add = (d: Node | null) => {
      const n = unwrapDeclarator(d);
      if (n?.type === "identifier") names.add(n.text);
      else if (n?.type === "init_declarator") add(n.childForFieldName("declarator"));
    };
    for (const p of declarator.childForFieldName("parameters")?.namedChildren ?? []) if (p !== null) add(p.childForFieldName("declarator"));
    for (const d of body.descendantsOfType(["declaration", "for_range_loop"])) {
      if (d === null) continue;
      for (const x of d.childrenForFieldName("declarator")) add(x);
    }
    return names;
  }

  private calls(body: Node, enclosing: SymbolRef | undefined, member: boolean, locals: ReadonlySet<string>): void {
    walk(body, (n) => {
      if (n.isError) return false;
      if (n.type === "comment") { this.c.comment(n); return false; }
      if (n.type === "call_expression") {
        const fn = n.childForFieldName("function");
        if (fn !== null) {
          const path = namePath(fn);
          const bare = fn.type === "identifier";
          this.c.call(n, bare ? "identifier" : "member", fn.text, path, enclosing, bare && locals.has(fn.text), bare && member);
        }
      } else if (n.type === "new_expression") {
        const type = n.childForFieldName("type");
        if (type !== null) this.c.call(n, "constructor", type.text, namePath(type) ?? [type.text], enclosing, false);
      }
      return true;
    });
  }
}

export function extractCpp(path: RepoPath, tree: Tree): Extraction {
  return new CppExtractor(path, tree).run();
}
