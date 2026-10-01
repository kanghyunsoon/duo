// T24.1 Phase 6 probe: what the pinned tree-sitter grammars give, as syntax only, for the parts a future overload
// member identity could use (parameter types, varargs, ref/out/in/params, generics, arrays, const and ref qualifiers,
// templates, operators, explicit interface members, constructors, destructors, macros). Prints, per callable, its name
// node and the S-expression of its parameter list and of the nodes around it. Nothing here is used by DUO.
//   node bench/experiments/signature-probe.mjs      (needs pnpm build)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const { loadGrammarSet } = await import("@duo-director/analyzer");
const analyzerEntry = fileURLToPath(import.meta.resolve("@duo-director/analyzer"));
// The ESM build: the same module instance the analyzer initialized (the CommonJS build has its own runtime).
const { Parser } = await import(pathToFileURL(createRequire(analyzerEntry).resolve("web-tree-sitter").replace(/\.cjs$/u, ".js")).href);
const grammars = (await loadGrammarSet(["java", "csharp", "cpp"])).value;

const SAMPLES = {
  java: [
    "class Svc<T> {",
    "  Svc() {}",
    "  Svc(int a) {}",
    "  <U> U foo(java.util.List<String> xs, int[] arr, int legacy[], String... rest) { return null; }",
    "  final int foo(final @Deprecated int x) { return x; }",
    "  class Inner { void foo(Inner other) {} }",
    "}",
  ],
  csharp: [
    "namespace N { class P<T> : I {",
    "  public P() {}",
    "  public void Move(ref int a, out int b, in int c, params int[] d) { b = 0; }",
    "  public void Move<U>(int? a, List<string> xs, int x = 1) {}",
    "  void I.Move() {}",
    "  public static P<T> operator +(P<T> a, P<T> b) => a;",
    "  public static implicit operator int(P<T> p) => 0;",
    "  public int this[int i] => i;",
    "  ~P() {}",
    "}}",
  ],
  cpp: [
    "namespace ns {",
    "class A {",
    "public:",
    "  A();",
    "  A(const A& o);",
    "  ~A();",
    "  int Fire() const;",
    "  int Fire(int count) &&;",
    "  template <typename T> T Get(T x);",
    "  A& operator=(const A&);",
    "  static int Make(int* p, int (&arr)[3], unsigned long n = 0);",
    "};",
    "int A::Fire() const { return 0; }",
    "#define DECL(x) void x();",
    "DECL(Shoot)",
    "}",
  ],
};
const CALLABLE = {
  java: ["method_declaration", "constructor_declaration"],
  csharp: ["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration", "indexer_declaration"],
  cpp: ["function_declarator"],
};
const out = {};
for (const [lang, lines] of Object.entries(SAMPLES)) {
  const parser = new Parser();
  parser.setLanguage(grammars.languages.get(lang));
  const tree = parser.parse(lines.join("\n"));
  const rows = [];
  const visit = (n) => {
    if (CALLABLE[lang].includes(n.type)) {
      const params = n.childForFieldName("parameters");
      const row = { line: n.startPosition.row + 1, type: n.type, name: n.childForFieldName("name")?.toString() ?? n.childForFieldName("declarator")?.toString() ?? null, parameters: params?.toString() ?? null };
      if (lang === "cpp") row.after = n.namedChildren.filter((c) => c !== null && c.startIndex >= (params?.endIndex ?? 0)).map((c) => c.toString());
      else row.other = n.namedChildren.filter((c) => c !== null && c !== params && !["block", "arrow_expression_clause", "modifiers", "modifier", "attribute_list"].includes(c.type)).map((c) => c.type + "=" + c.text.replace(/\s+/gu, " ").slice(0, 40));
      if (lang === "cpp" && n.parent?.parent?.type === "template_declaration") row.template = true;
      rows.push(row);
    }
    for (const c of n.namedChildren) if (c !== null) visit(c);
  };
  visit(tree.rootNode);
  out[lang] = { hasError: tree.rootNode.hasError, callables: rows };
  tree.delete(); parser.delete();
}
console.log(JSON.stringify(out, null, 1));
