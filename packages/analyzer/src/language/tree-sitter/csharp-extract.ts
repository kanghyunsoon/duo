/**
 * C# structural facts (T18.0, tree-sitter-c-sharp). Namespaces (block and file-scoped) are part of
 * the qualified name; they are not symbols. Symbols: classes, structs, interfaces, enums, records,
 * delegates, and methods, constructors, destructors and properties of types. A partial class declared
 * twice in one file is one symbol with two locations; partial declarations in other files are their
 * own file's symbols (identity is per file). usings stay as written (no MSBuild or NuGet). Tests:
 * NUnit, xUnit, MSTest and Unity Test Framework attributes, only with their framework's using.
 */
import type { RepoPath, SymbolRef } from "@duo-director/core";
import type { Node, Tree } from "web-tree-sitter";
import type { SymbolKind, TestFrameworkHint } from "../types.js";
import { StructuralCollector, walk } from "./structural.js";
import { hasErrorChild, type Extraction } from "./syntax.js";

const TYPE_KINDS: Readonly<Record<string, SymbolKind>> = {
  class_declaration: "class", struct_declaration: "struct", interface_declaration: "interface", enum_declaration: "enum",
  record_declaration: "record", record_struct_declaration: "record", delegate_declaration: "delegate",
};
const MEMBER_KINDS: Readonly<Record<string, SymbolKind>> = {
  method_declaration: "method", constructor_declaration: "constructor", destructor_declaration: "destructor", property_declaration: "property",
};
/** Test attributes by framework namespace (the using that binds them). */
const TEST_ATTRIBUTES: readonly { readonly namespace: string; readonly hint: TestFrameworkHint; readonly names: readonly string[] }[] = [
  { namespace: "NUnit.Framework", hint: "nunit", names: ["Test", "TestCase", "TestCaseSource", "Theory"] },
  { namespace: "UnityEngine.TestTools", hint: "nunit", names: ["UnityTest"] },
  { namespace: "Xunit", hint: "xunit", names: ["Fact", "Theory"] },
  { namespace: "Microsoft.VisualStudio.TestTools.UnitTesting", hint: "mstest", names: ["TestMethod", "DataTestMethod"] },
];

const modifierWords = (node: Node) => node.namedChildren.filter((c) => c?.type === "modifier").map((c) => c?.text ?? "");

function namePath(node: Node | null): string[] | undefined {
  if (node === null) return undefined;
  if (node.type === "identifier" || node.type === "this_expression" || node.type === "this" || node.type === "base_expression") return [node.text];
  if (node.type === "generic_name") return [node.namedChildren[0]?.text ?? node.text];
  if (node.type === "member_access_expression") {
    const base = namePath(node.childForFieldName("expression"));
    const name = node.childForFieldName("name");
    return base === undefined || name === null ? undefined : [...base, name.type === "generic_name" ? (name.namedChildren[0]?.text ?? name.text) : name.text];
  }
  if (node.type === "qualified_name") return node.text.split(".");
  return undefined;
}

class CSharpExtractor {
  private readonly c: StructuralCollector;
  private readonly usings = new Set<string>();

  constructor(path: RepoPath, private readonly tree: Tree) {
    this.c = new StructuralCollector(path);
  }

  run(): Extraction {
    let namespace: string[] = [];
    for (const n of this.tree.rootNode.namedChildren) {
      if (n === null) continue;
      if (n.type === "file_scoped_namespace_declaration") {
        // Applies to every declaration after it in the file (and to its own children in some grammar versions).
        namespace = (n.childForFieldName("name")?.text ?? "").split(".").filter((s) => s !== "");
        for (const child of n.namedChildren) if (child !== null && child !== n.childForFieldName("name")) walk(child, (x) => this.visit(x, namespace, [], undefined));
        continue;
      }
      walk(n, (x) => this.visit(x, namespace, [], undefined));
    }
    return this.c.finish(this.tree);
  }

  private using(node: Node): void {
    const alias = node.childForFieldName("name")?.text;
    const target = node.namedChildren.filter((c) => c !== null && c !== node.childForFieldName("name") && (c.type === "qualified_name" || c.type === "identifier" || c.type === "generic_name")).at(-1);
    if (target === undefined || target === null) return;
    const tokens = node.children.filter((c) => c !== null && !c.isNamed).map((c) => c?.type);
    this.c.module(node, target.text, "using", alias === undefined ? [] : [{ local: alias, imported: target.text, typeOnly: false }], {
      ...(tokens.includes("static") ? { static: true as const } : {}), ...(tokens.includes("global") ? { global: true as const } : {}), ...(alias === undefined ? {} : { alias }),
    });
    if (alias === undefined) this.usings.add(target.text);
  }

  private testAttribute(method: Node): TestFrameworkHint | undefined {
    for (const list of method.namedChildren.filter((c) => c?.type === "attribute_list")) {
      for (const attr of (list?.namedChildren ?? []).filter((a) => a?.type === "attribute")) {
        const full = attr?.childForFieldName("name")?.text ?? "";
        const simple = full.slice(full.lastIndexOf(".") + 1).replace(/Attribute$/u, "");
        const ns = full.includes(".") ? full.slice(0, full.lastIndexOf(".")) : undefined;
        const framework = TEST_ATTRIBUTES.find((f) => f.names.includes(simple) && (ns === undefined ? this.usings.has(f.namespace) : ns === f.namespace));
        if (framework !== undefined) return framework.hint;
      }
    }
    return undefined;
  }

  private visit(node: Node, namespace: readonly string[], types: readonly string[], member: SymbolRef | undefined): boolean {
    if (node.isError) return false;
    if (node.type === "comment") { this.c.comment(node); return false; }
    if (node.type === "using_directive") { if (!node.hasError) this.using(node); return false; }
    if (node.type === "namespace_declaration") {
      const inner = [...namespace, ...(node.childForFieldName("name")?.text ?? "").split(".").filter((s) => s !== "")];
      const body = node.childForFieldName("body");
      if (body !== null) walk(body, (x) => this.visit(x, inner, [], undefined));
      return false;
    }
    const typeKind = TYPE_KINDS[node.type];
    if (typeKind !== undefined) {
      const name = node.childForFieldName("name")?.text;
      if (name === undefined || member !== undefined || hasErrorChild(node)) return true;
      const chain = [...types, name];
      const qualifiedName = [...namespace, ...chain].join(".");
      const parent = types.length === 0 ? undefined : [...namespace, ...types].join(".");
      this.c.symbol({ name, qualifiedName, kind: typeKind, exported: modifierWords(node).includes("public"), ...(parent === undefined ? {} : { parent }), node, hasBody: typeKind !== "delegate" });
      for (const child of node.namedChildren) if (child !== null) walk(child, (x) => this.visit(x, namespace, chain, undefined));
      return false;
    }
    const memberKind = MEMBER_KINDS[node.type];
    if (memberKind !== undefined && types.length > 0 && member === undefined) {
      const raw = node.childForFieldName("name")?.text;
      if (raw === undefined || hasErrorChild(node)) return true;
      const name = memberKind === "destructor" ? `~${raw}` : raw;
      const owner = [...namespace, ...types].join(".");
      const words = modifierWords(node);
      const memberScope = words.includes("static") ? "static" as const : "instance" as const;
      const hasBody = memberKind === "property" || node.childForFieldName("body") !== null || node.namedChildren.some((c) => c?.type === "arrow_expression_clause");
      const ref = this.c.symbol({ name, qualifiedName: `${owner}.${name}`, kind: memberKind, exported: words.includes("public"), memberScope, parent: owner, node, hasBody });
      if (memberKind === "method") {
        const hint = this.testAttribute(node);
        if (hint !== undefined) this.c.test(node, { name, suites: [owner], hint, confidence: "explicit", enclosing: ref });
      }
      for (const child of node.namedChildren) if (child !== null) walk(child, (x) => this.visit(x, namespace, types, ref));
      return false;
    }
    if (node.type === "invocation_expression") {
      const fn = node.childForFieldName("function");
      if (fn !== null) this.c.call(node, fn.type === "member_access_expression" ? "member" : "identifier", fn.text, namePath(fn), member, false);
      return true;
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type");
      if (type !== null) this.c.call(node, "constructor", type.text, namePath(type) ?? [type.text], member, false);
      return true;
    }
    return true;
  }
}

export function extractCSharp(path: RepoPath, tree: Tree): Extraction {
  return new CSharpExtractor(path, tree).run();
}
