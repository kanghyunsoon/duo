/**
 * Java structural facts (T18.0, tree-sitter-java). Symbols: classes, interfaces, enums, records and
 * annotation types (nested types with their owner), methods and constructors of those types. Local
 * and anonymous classes and lambdas are not symbols; their calls belong to the enclosing member.
 * Imports are kept as written (no classpath). Tests: JUnit @Test-style annotations bound by an
 * import (explicit), or @Test in a Maven/Gradle test source set without a JUnit import (heuristic).
 */
import type { RepoPath, SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { SymbolKind, TestConfidence, TestFrameworkHint } from "../types.js";
import { StructuralCollector, walk } from "./structural.js";
import { hasErrorChild, type Extraction } from "./syntax.js";

const TYPE_KINDS: Readonly<Record<string, SymbolKind>> = {
  class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "record", annotation_type_declaration: "interface",
};
const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"]);
const JUNIT5_PACKAGES = ["org.junit.jupiter.api", "org.junit.jupiter.params"];
const JUNIT4_PACKAGE = "org.junit";
const TEST_SOURCE_SET = /(^|\/)src\/(test|integrationTest|it)\/java\//u;

const modifiersOf = (node: Node) => node.namedChildren.find((c) => c?.type === "modifiers") ?? null;
const hasModifier = (node: Node, word: string) => (modifiersOf(node)?.children ?? []).some((c) => c !== null && !c.isNamed && c.type === word);

/** Dotted name path of a callee object: a, a.b, this, super; undefined for anything computed. */
function namePath(node: Node | null): string[] | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier" || node.type === "this" || node.type === "super") return [node.text];
  if (node.type === "field_access") {
    const base = namePath(node.childForFieldName("object"));
    const field = node.childForFieldName("field");
    return base === undefined || field === null ? undefined : [...base, field.text];
  }
  if (node.type === "scoped_identifier") return node.text.split(".");
  return undefined;
}

class JavaExtractor {
  private readonly c: StructuralCollector;
  /** Imported names of test annotations → framework, and wildcard-imported packages. */
  private readonly annotationImports = new Map<string, TestFrameworkHint>();
  private readonly wildcardImports = new Set<string>();

  constructor(private readonly path: RepoPath, private readonly tree: Tree) {
    this.c = new StructuralCollector(path);
  }

  run(): Extraction {
    for (const n of this.tree.rootNode.namedChildren) if (n?.type === "import_declaration" && !n.hasError) this.importDeclaration(n);
    walk(this.tree.rootNode, (n) => this.visit(n, [], undefined));
    return this.c.finish(this.tree);
  }

  private importDeclaration(node: Node): void {
    const name = node.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier");
    if (name === undefined || name === null) return;
    const wildcard = node.namedChildren.some((c) => c?.type === "asterisk");
    const isStatic = node.children.some((c) => c !== null && !c.isNamed && c.type === "static");
    const specifier = wildcard ? `${name.text}.*` : name.text;
    const last = name.text.slice(name.text.lastIndexOf(".") + 1);
    this.c.module(node, specifier, "import", wildcard ? [] : [{ local: last, imported: last, typeOnly: false }], { ...(isStatic ? { static: true as const } : {}), ...(wildcard ? { wildcard: true as const } : {}) });
    if (wildcard) this.wildcardImports.add(name.text);
    else {
      const pkg = name.text.slice(0, name.text.lastIndexOf("."));
      if (TEST_ANNOTATIONS.has(last) && JUNIT5_PACKAGES.includes(pkg)) this.annotationImports.set(last, "junit5");
      else if (last === "Test" && pkg === JUNIT4_PACKAGE) this.annotationImports.set(last, "junit4");
    }
  }

  /** The JUnit framework of an annotation, and how certain it is; undefined when it is not a test annotation. */
  private testAnnotation(annotation: Node): { hint: TestFrameworkHint; confidence: TestConfidence } | undefined {
    const name = annotation.childForFieldName("name");
    if (name === null) return undefined;
    const text = name.text;
    const simple = text.slice(text.lastIndexOf(".") + 1);
    if (!TEST_ANNOTATIONS.has(simple)) return undefined;
    if (text.includes(".")) {
      const pkg = text.slice(0, text.lastIndexOf("."));
      if (JUNIT5_PACKAGES.includes(pkg)) return { hint: "junit5", confidence: "explicit" };
      if (pkg === JUNIT4_PACKAGE && simple === "Test") return { hint: "junit4", confidence: "explicit" };
      return undefined;
    }
    const bound = this.annotationImports.get(simple);
    if (bound !== undefined) return { hint: bound, confidence: "explicit" };
    if (JUNIT5_PACKAGES.some((p) => this.wildcardImports.has(p))) return { hint: "junit5", confidence: "explicit" };
    if (simple === "Test" && this.wildcardImports.has(JUNIT4_PACKAGE)) return { hint: "junit4", confidence: "explicit" };
    if (simple === "Test" && TEST_SOURCE_SET.test(this.path)) return { hint: "unknown", confidence: "heuristic" };
    return undefined;
  }

  /** types: the enclosing type chain; member: the enclosing method or constructor (calls belong to it). */
  private visit(node: Node, types: readonly string[], member: SymbolRef | undefined): boolean {
    if (node.isError) return false;
    if (node.type === "line_comment" || node.type === "block_comment") { this.c.comment(node); return false; }
    const typeKind = TYPE_KINDS[node.type];
    if (typeKind !== undefined) {
      const name = node.childForFieldName("name")?.text;
      // Local classes (inside a member body) are not symbols; their calls stay with the member.
      if (name === undefined || member !== undefined || hasErrorChild(node)) return true;
      const chain = [...types, name];
      const parent = types.length === 0 ? undefined : types.join(".");
      this.c.symbol({ name, qualifiedName: chain.join("."), kind: typeKind, exported: hasModifier(node, "public"), ...(parent === undefined ? {} : { parent }), node, hasBody: true });
      for (const child of node.namedChildren) if (child !== null) walk(child, (n) => this.visit(n, chain, undefined));
      return false;
    }
    if ((node.type === "method_declaration" || node.type === "constructor_declaration" || node.type === "compact_constructor_declaration") && types.length > 0 && member === undefined) {
      const name = node.childForFieldName("name")?.text;
      if (name === undefined || hasErrorChild(node)) return true;
      const owner = types.join(".");
      const isMethod = node.type === "method_declaration";
      const memberScope = isMethod && hasModifier(node, "static") ? "static" as const : "instance" as const;
      const ref = this.c.symbol({
        name, qualifiedName: `${owner}.${name}`, kind: isMethod ? "method" : "constructor", exported: hasModifier(node, "public"), memberScope, parent: owner,
        node, hasBody: node.childForFieldName("body") !== null,
      });
      if (isMethod) {
        const annotations = (modifiersOf(node)?.namedChildren ?? []).filter((a) => a?.type === "marker_annotation" || a?.type === "annotation");
        const test = annotations.map((a) => (a === null ? undefined : this.testAnnotation(a))).find((t) => t !== undefined);
        if (test !== undefined) this.c.test(node, { name, suites: [owner], ...test, enclosing: ref });
      }
      for (const child of node.namedChildren) if (child !== null) walk(child, (n) => this.visit(n, types, ref));
      return false;
    }
    if (node.type === "method_invocation") {
      const name = node.childForFieldName("name");
      const object = node.childForFieldName("object");
      if (name !== null) {
        const base = object === null ? [] : namePath(object);
        this.c.call(node, object === null ? "identifier" : "member", object === null ? name.text : `${object.text}.${name.text}`, base === undefined ? undefined : [...base, name.text], member, false);
      }
      return true;
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type");
      if (type !== null) this.c.call(node, "constructor", type.text, type.text.replace(/<.*$/su, "").split("."), member, false);
      return true;
    }
    return true;
  }
}

export function extractJava(path: RepoPath, tree: Tree): Extraction {
  return new JavaExtractor(path, tree).run();
}
