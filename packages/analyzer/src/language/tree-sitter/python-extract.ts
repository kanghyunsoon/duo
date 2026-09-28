/**
 * Python structural facts (T18.0, tree-sitter-python). Symbols: module-level functions and classes
 * (also inside module-level if/try blocks), methods (__init__ is the constructor), nested classes.
 * Functions nested in functions are not symbols; their calls belong to the outer function. A
 * decorated definition's location includes its decorators. Imports stay as written (relative level
 * kept). Tests: pytest (test_* functions and Test* class methods in test_*.py / *_test.py files) and
 * unittest (test_* methods of a unittest.TestCase subclass, in any file).
 */
import type { RepoPath, SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { ImportBinding, TestFrameworkHint } from "../types.js";
import { StructuralCollector, walk } from "./structural.js";
import { hasErrorChild, type Extraction } from "./syntax.js";

const PYTEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/u;

const exportedName = (name: string) => !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"));

function namePath(node: Node | null): string[] | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier") return [node.text];
  if (node.type === "attribute") {
    const base = namePath(node.childForFieldName("object"));
    const attr = node.childForFieldName("attribute");
    return base === undefined || attr === null ? undefined : [...base, attr.text];
  }
  return undefined;
}

/** Names a statement binds in its scope (assignment targets, for targets, with/except aliases, imports, def, class). */
function boundNames(node: Node, into: Set<string>): void {
  walk(node, (n) => {
    if (n.type === "function_definition" || n.type === "class_definition" || n.type === "lambda") {
      const name = n.childForFieldName("name");
      if (name !== null && n !== node) into.add(name.text);
      return n === node;
    }
    if (n.type === "assignment" || n.type === "augmented_assignment" || n.type === "for_statement" || n.type === "for_in_clause") {
      const left = n.childForFieldName("left");
      if (left !== null) for (const id of [left, ...left.descendantsOfType("identifier")]) if (id?.type === "identifier" && id.parent?.type !== "attribute") into.add(id.text);
    }
    if (n.type === "as_pattern" || n.type === "as_pattern_target") for (const id of n.descendantsOfType("identifier")) if (id !== null) into.add(id.text);
    if (n.type === "named_expression") { const name = n.childForFieldName("name"); if (name !== null) into.add(name.text); }
    if (n.type === "import_statement" || n.type === "import_from_statement") {
      for (const a of n.descendantsOfType("aliased_import")) { const alias = a?.childForFieldName("alias"); if (alias !== null && alias !== undefined) into.add(alias.text); }
      for (const d of n.childrenForFieldName("name")) if (d?.type === "dotted_name") into.add(d.namedChildren[0]?.text ?? d.text);
    }
    return true;
  });
}

class PythonExtractor {
  private readonly c: StructuralCollector;
  private readonly testFile: boolean;
  /** Module-level names bound by something other than one def/class (imports, assignments, repeated defs). */
  private readonly moduleBound = new Set<string>();
  /** Local names that mean unittest.TestCase. */
  private readonly testCaseNames = new Set<string>();
  private readonly unittestModules = new Set<string>();
  private pytestImported = false;

  constructor(path: RepoPath, private readonly tree: Tree) {
    this.c = new StructuralCollector(path);
    this.testFile = PYTEST_FILE.test(path);
  }

  run(): Extraction {
    const defs = new Map<string, number>();
    for (const n of this.tree.rootNode.namedChildren) {
      if (n === null) continue;
      const def = n.type === "decorated_definition" ? n.childForFieldName("definition") : n;
      if (def?.type === "function_definition" || def?.type === "class_definition") {
        const name = def.childForFieldName("name")?.text;
        if (name !== undefined) defs.set(name, (defs.get(name) ?? 0) + 1);
      } else boundNames(n, this.moduleBound);
    }
    for (const [name, count] of defs) if (count > 1) this.moduleBound.add(name);
    walk(this.tree.rootNode, (n) => this.visit(n, [], undefined, new Set()));
    return this.c.finish(this.tree);
  }

  private imports(node: Node): void {
    if (node.hasError) return;
    if (node.type === "import_statement") {
      for (const item of node.childrenForFieldName("name")) {
        if (item === null) continue;
        const dotted = item.type === "aliased_import" ? item.childForFieldName("name") : item;
        const alias = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : undefined;
        if (dotted === null) continue;
        const local = alias ?? dotted.text.split(".")[0] ?? dotted.text;
        this.c.module(node, dotted.text, "import", [{ local, imported: "*", typeOnly: false }]);
        if (dotted.text === "unittest") this.unittestModules.add(local);
        if (dotted.text === "pytest") this.pytestImported = true;
      }
      return;
    }
    // import_from_statement
    const moduleNode = node.childForFieldName("module_name");
    if (moduleNode === null) return;
    let level = 0;
    let dotted = moduleNode.text;
    if (moduleNode.type === "relative_import") {
      const prefix = moduleNode.namedChildren.find((c) => c?.type === "import_prefix");
      level = prefix?.text.length ?? 0;
      dotted = moduleNode.namedChildren.find((c) => c?.type === "dotted_name")?.text ?? "";
    }
    const specifier = `${".".repeat(level)}${dotted}`;
    const wildcard = node.namedChildren.some((c) => c?.type === "wildcard_import");
    const bindings: ImportBinding[] = [];
    for (const item of node.childrenForFieldName("name")) {
      if (item === null) continue;
      const nameNode = item.type === "aliased_import" ? item.childForFieldName("name") : item;
      const alias = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : undefined;
      if (nameNode === null) continue;
      bindings.push({ local: alias ?? nameNode.text, imported: nameNode.text, typeOnly: false });
    }
    const syntax = { ...(wildcard ? { wildcard: true as const } : {}), ...(level > 0 ? { relativeLevel: level } : {}) };
    if (dotted === "" && level > 0) {
      // from . import a, b: each name is a submodule (or a package attribute): one reference per name.
      for (const b of bindings) this.c.module(node, `${specifier}${b.imported}`, "import", [{ local: b.local, imported: "*", typeOnly: false }], syntax);
    } else {
      this.c.module(node, specifier, "import", bindings, syntax);
    }
    if (level === 0 && dotted === "unittest") for (const b of bindings) if (b.imported === "TestCase") this.testCaseNames.add(b.local);
    if (level === 0 && dotted === "pytest") this.pytestImported = true;
  }

  private isUnittestCase(cls: Node): boolean {
    for (const base of cls.childForFieldName("superclasses")?.namedChildren ?? []) {
      const path = base === null ? undefined : namePath(base);
      if (path === undefined) continue;
      if (path.length === 1 && this.testCaseNames.has(path[0] as string)) return true;
      if (path.length === 2 && this.unittestModules.has(path[0] as string) && path[1] === "TestCase") return true;
    }
    return false;
  }

  private staticDecorated(outer: Node): boolean {
    if (outer.type !== "decorated_definition") return false;
    return outer.namedChildren.some((d) => d?.type === "decorator" && /^@\s*(staticmethod|classmethod)\b/u.test(d.text));
  }

  /**
   * classes: enclosing class chain; fn: the enclosing function symbol (calls belong to it); locals:
   * names bound in the enclosing function scopes.
   */
  private visit(node: Node, classes: readonly { name: string; tests?: { hint: TestFrameworkHint; explicit: boolean } }[], fn: SymbolRef | undefined, locals: ReadonlySet<string>): boolean {
    if (node.isError) return false;
    switch (node.type) {
      case "comment": this.c.comment(node); return false;
      case "import_statement": case "import_from_statement": if (fn === undefined && classes.length === 0) this.imports(node); return false;
      case "call": {
        const f = node.childForFieldName("function");
        if (f !== null) {
          const bare = f.type === "identifier";
          const rootLocal = bare && (locals.has(f.text) || this.moduleBound.has(f.text));
          this.c.call(node, bare ? "identifier" : "member", f.text, namePath(f), fn, rootLocal);
        }
        return true;
      }
      case "class_definition": case "function_definition": {
        const outer = node.parent?.type === "decorated_definition" ? node.parent : node;
        const name = node.childForFieldName("name")?.text;
        if (name === undefined || hasErrorChild(node) || hasErrorChild(outer)) return false;
        if (fn !== undefined) {
          // Nested in a function: not a symbol; its calls belong to the outer function.
          const inner = new Set(locals);
          boundNames(node, inner);
          for (const p of node.childForFieldName("parameters")?.descendantsOfType("identifier") ?? []) if (p !== null) inner.add(p.text);
          const body = node.childForFieldName("body");
          if (body !== null) walk(body, (n) => this.visit(n, classes, fn, inner));
          return false;
        }
        const owner = classes.length === 0 ? undefined : classes.map((c) => c.name).join(".");
        const qualifiedName = owner === undefined ? name : `${owner}.${name}`;
        if (node.type === "class_definition") {
          this.c.symbol({ name, qualifiedName, kind: "class", exported: exportedName(name), ...(owner === undefined ? {} : { parent: owner }), node: outer, hasBody: true });
          const unittest = this.isUnittestCase(node);
          const pytestClass = this.testFile && /^Test/u.test(name) && !node.descendantsOfType("function_definition").some((d) => d?.childForFieldName("name")?.text === "__init__");
          const tests = unittest ? { hint: "unittest" as const, explicit: true } : pytestClass ? { hint: "pytest" as const, explicit: this.pytestImported } : undefined;
          const body = node.childForFieldName("body");
          if (body !== null) walk(body, (n) => this.visit(n, [...classes, { name, ...(tests === undefined ? {} : { tests }) }], undefined, new Set()));
          return false;
        }
        const isMethod = owner !== undefined;
        const kind = isMethod ? (name === "__init__" ? "constructor" : "method") : "function";
        const memberScope = isMethod ? (this.staticDecorated(outer) ? "static" as const : "instance" as const) : undefined;
        const ref = this.c.symbol({ name, qualifiedName, kind, exported: exportedName(name), ...(memberScope === undefined ? {} : { memberScope }), ...(owner === undefined ? {} : { parent: owner }), node: outer, hasBody: true });
        const cls = classes.at(-1);
        if (/^test/u.test(name)) {
          if (cls?.tests !== undefined) this.c.test(outer, { name, suites: classes.map((c) => c.name), hint: cls.tests.hint, confidence: cls.tests.explicit ? "explicit" : "heuristic", enclosing: ref });
          else if (!isMethod && this.testFile) this.c.test(outer, { name, suites: [], hint: "pytest", confidence: this.pytestImported ? "explicit" : "heuristic", enclosing: ref });
        }
        const scope = new Set<string>();
        for (const p of node.childForFieldName("parameters")?.descendantsOfType("identifier") ?? []) if (p !== null) scope.add(p.text);
        const body = node.childForFieldName("body");
        if (body !== null) {
          for (const s of body.namedChildren) if (s !== null) boundNames(s, scope);
          walk(body, (n) => this.visit(n, classes, ref, scope));
        }
        // Decorators were visited already (children of decorated_definition, in the enclosing scope).
        return false;
      }
      default:
        // Blocks (if/try/with at module or class level, decorated definitions, statements) keep the scope.
        return true;
    }
  }
}

export function extractPython(path: RepoPath, tree: Tree): Extraction {
  return new PythonExtractor(path, tree).run();
}
