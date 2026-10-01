/**
 * Python structural facts (T18.0, tree-sitter-python). Symbols: module-level functions and classes
 * (also inside module-level if/try blocks), methods (__init__ is the constructor), nested classes.
 * Functions nested in functions are not symbols; their calls belong to the outer function. A
 * decorated definition's location includes its decorators. Imports stay as written (relative level
 * kept). Tests: pytest (test_* functions and Test* class methods in test_*.py / *_test.py files) and
 * unittest (test_* methods of a unittest.TestCase subclass, in any file).
 *
 * Same-name definitions in one scope are one Symbol (T18.0). Its primary location is the effective
 * definition only where syntax shows it (T24.4, C226; see preferredDefinition); otherwise the first.
 */
import { compareSourceLocations, type RepoPath, type SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { ImportBinding, TestFrameworkHint } from "../types.js";
import { StructuralCollector, walk } from "./structural.js";
import { hasErrorChild, location, type Extraction } from "./syntax.js";

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
function boundNames(node: Node, into: Set<string>, imports = true): void {
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
    if (imports && (n.type === "import_statement" || n.type === "import_from_statement")) {
      for (const a of n.descendantsOfType("aliased_import")) { const alias = a?.childForFieldName("alias"); if (alias !== null && alias !== undefined) into.add(alias.text); }
      for (const d of n.childrenForFieldName("name")) if (d?.type === "dotted_name") into.add(d.namedChildren[0]?.text ?? d.text);
    }
    return true;
  });
}

/** One def or class that became (part of) a Symbol, for the effective-definition rule (T24.4). */
interface Definition {
  readonly identity: string;
  readonly name: string;
  readonly isClass: boolean;
  /** The statement: the decorated_definition when decorated. */
  readonly outer: Node;
  /** The suite the statement is in (module, or a block). */
  readonly suite: Node | null;
}

type DecoratorKind = "overload" | "neutral" | "other";

const sameNode = (a: Node | null, b: Node | null) =>
  a !== null && b !== null && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

class PythonExtractor {
  private readonly c: StructuralCollector;
  private readonly testFile: boolean;
  /** Module-level names bound by something other than one def/class (imports, assignments, repeated defs). */
  private readonly moduleBound = new Set<string>();
  /** Local names that mean unittest.TestCase. */
  private readonly testCaseNames = new Set<string>();
  private readonly unittestModules = new Set<string>();
  private pytestImported = false;
  /** Local name → each module-level import that binds it ("from typing import overload", "import typing"). */
  private readonly importLocals = new Map<string, string[]>();
  /** Module-level names bound by something other than an import (def, class, assignment, del, ...). */
  private readonly moduleOtherBound = new Set<string>();
  private readonly definitions: Definition[] = [];

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
        if (name !== undefined) { defs.set(name, (defs.get(name) ?? 0) + 1); this.moduleOtherBound.add(name); }
      } else {
        boundNames(n, this.moduleBound);
        boundNames(n, this.moduleOtherBound, false);
      }
    }
    for (const [name, count] of defs) if (count > 1) this.moduleBound.add(name);
    walk(this.tree.rootNode, (n) => this.visit(n, [], undefined, new Set()));
    this.preferDefinitions();
    return this.c.finish(this.tree);
  }

  /** Records that a module-level import binds local (the import as written, alias included). */
  private importLocal(local: string, written: string): void {
    this.importLocals.set(local, [...(this.importLocals.get(local) ?? []), written]);
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
        this.importLocal(local, `import ${dotted.text}${alias === undefined ? "" : ` as ${alias}`}`);
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
      this.importLocal(alias ?? nameNode.text, `from ${specifier} import ${nameNode.text}${alias === undefined ? "" : ` as ${alias}`}`);
    }
    if (wildcard) this.importLocal("*", `from ${specifier} import *`);
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

  /** The effective definition of each Symbol made of several defs, where syntax shows it (T24.4, C226). */
  private preferDefinitions(): void {
    const groups = new Map<string, Definition[]>();
    for (const d of this.definitions) groups.set(d.identity, [...(groups.get(d.identity) ?? []), d]);
    for (const [identity, group] of groups) {
      if (group.length < 2) continue;
      const chosen = this.preferredDefinition(group);
      if (chosen !== undefined) this.c.prefer(identity, chosen.outer);
    }
  }

  /**
   * Each def statement binds its name again, so of several defs of one name in one suite that always
   * runs, the last one is the binding the suite leaves. Only when nothing else is in play:
   * - every definition is a function (a group with a class keeps the first location);
   * - all of them are in one suite, the module or a class body: inside if / try / with / for / while
   *   the binding depends on execution (no guess);
   * - nothing else in that suite binds or deletes the name (assignment, import, del, a block with a
   *   def of the name, a def of the name that is a separate Symbol);
   * - the decorators are staticmethod / classmethod (already part of the identity) and recognized
   *   typing.overload only. Any other decorator (property, x.setter, a route decorator, an overload
   *   alias) may build on or register the earlier binding: no guess.
   * Without overload stubs the last def is effective. With stubs, the one def without @overload when
   * it is the last def (the stubs stay locations of the Symbol); no implementation, more than one, or
   * a stub after it: no guess. Order is canonical source order within the one file.
   */
  private preferredDefinition(group: readonly Definition[]): Definition | undefined {
    const first = group[0];
    if (first === undefined || group.some((d) => d.isClass)) return undefined;
    const suite = first.suite;
    if (suite === null || !group.every((d) => sameNode(d.suite, suite))) return undefined;
    if (!(suite.type === "module" || (suite.type === "block" && suite.parent?.type === "class_definition"))) return undefined;
    // Names the suite binds besides the group (in a class body these shadow overload / typing).
    const bound = new Set<string>();
    for (const s of suite.namedChildren) {
      if (s === null || group.some((d) => sameNode(d.outer, s))) continue;
      const def = s.type === "decorated_definition" ? s.childForFieldName("definition") : s;
      if (def?.type === "function_definition" || def?.type === "class_definition") {
        const n = def.childForFieldName("name")?.text;
        if (n !== undefined) bound.add(n);
        continue;
      }
      boundNames(s, bound);
      for (const d of s.type === "delete_statement" ? [s] : s.descendantsOfType("delete_statement")) {
        for (const id of d?.descendantsOfType("identifier") ?? []) if (id !== null && id.parent?.type !== "attribute") bound.add(id.text);
      }
    }
    if (bound.has(first.name)) return undefined;
    const shadow = suite.type === "module" ? new Set<string>() : bound;
    const defs = group.map((d) => {
      const kinds = this.decorators(d.outer).map((x) => this.decoratorKind(x, shadow));
      return { d, kinds, at: location(this.c.path, d.outer) };
    });
    if (defs.some((x) => x.kinds.includes("other"))) return undefined;
    defs.sort((a, b) => compareSourceLocations(a.at, b.at));
    const last = defs[defs.length - 1];
    if (last === undefined) return undefined;
    if (!defs.some((x) => x.kinds.includes("overload"))) return last.d;
    const impls = defs.filter((x) => !x.kinds.includes("overload"));
    return impls.length === 1 && impls[0] === last ? last.d : undefined;
  }

  private decorators(outer: Node): Node[] {
    return outer.type === "decorated_definition" ? outer.namedChildren.filter((d): d is Node => d?.type === "decorator") : [];
  }

  /**
   * overload: `@overload` with `from typing import overload`, or `@typing.overload` with `import typing`,
   * each the only binding of that name (no alias, no star import, no other assignment, def or import,
   * not shadowed in the class body). neutral: `@staticmethod`, `@classmethod`. Anything else: other.
   */
  private decoratorKind(decorator: Node, shadow: ReadonlySet<string>): DecoratorKind {
    const e = decorator.namedChildren.find((c) => c !== null && c.type !== "comment") ?? null;
    if (e === null) return "other";
    if (e.type === "identifier") {
      if (e.text === "staticmethod" || e.text === "classmethod") return "neutral";
      return e.text === "overload" && this.onlyImport("overload", "from typing import overload", shadow) ? "overload" : "other";
    }
    const object = e.type === "attribute" ? e.childForFieldName("object") : null;
    if (object?.type === "identifier" && object.text === "typing" && e.childForFieldName("attribute")?.text === "overload"
      && this.onlyImport("typing", "import typing", shadow)) return "overload";
    return "other";
  }

  private onlyImport(local: string, written: string, shadow: ReadonlySet<string>): boolean {
    const imports = this.importLocals.get(local) ?? [];
    return imports.length === 1 && imports[0] === written && !this.importLocals.has("*") && !this.moduleOtherBound.has(local) && !shadow.has(local);
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
          const cref = this.c.symbol({ name, qualifiedName, kind: "class", exported: exportedName(name), ...(owner === undefined ? {} : { parent: owner }), node: outer, hasBody: true });
          this.definitions.push({ identity: cref.symbol, name, isClass: true, outer, suite: outer.parent });
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
        this.definitions.push({ identity: ref.symbol, name, isClass: false, outer, suite: outer.parent });
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
