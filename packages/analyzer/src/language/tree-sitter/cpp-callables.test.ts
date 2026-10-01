/**
 * C++ callable facts (T24.3, C218): role and syntactic signature per declaration. Syntax only: names,
 * default values and comments are left out; spelling (const placement, qualification, arrays) is kept.
 */
import type { RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";
import type { AnalyzerRegistry } from "../registry.js";
import type { SourceAnalysis } from "../types.js";

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  registry = created.value;
});
afterAll(() => registry?.dispose());

function analyze(path: string, lines: readonly string[]): SourceAnalysis {
  const r = registry.analyze({ path: path as RepoPath, content: new TextEncoder().encode(lines.join("\n")) });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
/** qualifiedName -> "role signature" per callable, in location order ("-" when the declaration is never linked). */
const facts = (a: SourceAnalysis) => Object.fromEntries(a.symbols.filter((s) => s.callables !== undefined)
  .map((s) => [s.qualifiedName, (s.callables ?? []).map((c) => `${c.role} ${c.signature ?? "-"}`)]));

describe("C++ callable facts (T24.3, C218)", () => {
  it("parameter types without names, default values and comments; cv and ref qualifiers", () => {
    const a = analyze("src/W.hpp", [
      "class W {",
      "public:",
      "  void A(int value = 1, const char* name = \"x\");",
      "  void B(int /* count */ count, unsigned   long n);",
      "  int C() const;",
      "  int C();",
      "  void D() &;",
      "  void D() &&;",
      "  void E(void);",
      "  void F(int first, ...);",
      "  void G(void (*callback)(int), int (&values)[3]);",
      "  bool operator==(const W& other) const;",
      "  auto H() -> int;",
      "  void I() noexcept;",
      "  W();",
      "  ~W();",
      "  static int S(int v);",
      "};",
    ]);
    expect(facts(a)).toEqual({
      "W.A": ["declaration (int,const char*)"],
      "W.B": ["declaration (int,unsigned long)"],
      "W.C": ["declaration ()const", "declaration ()"],
      "W.D": ["declaration ()&", "declaration ()&&"],
      "W.E": ["declaration ()"],
      "W.F": ["declaration (int,...)"],
      "W.G": ["declaration (void(*)(int),int(&)[3])"],
      "W.operator==": ["declaration (const W&)const"],
      "W.H": ["declaration ()"],
      "W.I": ["declaration ()"],
      "W.W": ["declaration ()"],
      "W.~W": ["declaration ()"],
      "W.S": ["declaration (int)"],
    });
  });

  it("an out-of-line definition has the role definition and the same signature as its declaration", () => {
    const a = analyze("src/W.cpp", [
      "#include \"W.h\"",
      "void W::A(int value, const char* name) {}",
      "int W::C() const { return 1; }",
      "namespace game { void Run(int v) { (void)v; } }",
    ]);
    expect(facts(a)).toEqual({ "W.A": ["definition (int,const char*)"], "W.C": ["definition ()const"], "game.Run": ["definition (int)"] });
  });

  it("spelling is not normalized: const placement, qualification and array forms differ", () => {
    const a = analyze("src/X.hpp", ["void P(const int v);", "void Q(int const v);", "void R(std::string s);", "void T(string s);", "void U(int a[]);", "void V(int* a);"]);
    expect(facts(a)).toEqual({
      P: ["declaration (const int)"], Q: ["declaration (int const)"], R: ["declaration (std::string)"], T: ["declaration (string)"], U: ["declaration (int[])"], V: ["declaration (int*)"],
    });
  });

  it("never linked: templates, internal linkage, friends, = default and = delete, inline definitions keep their role", () => {
    const a = analyze("src/Y.cpp", [
      "template <typename T> void Tpl(T v) {}",
      "template <typename T> class Box { public: void Put(T v); };",
      "template <typename T> void Box<T>::Put(T v) {}",
      "static int Hidden(int v) { return v; }",
      "namespace { int Anon(int v) { return v; } }",
      "class Y {",
      "public:",
      "  friend void Peer(Y& y);",
      "  Y() = default;",
      "  Y(const Y&) = delete;",
      "  void Inline() {}",
      "};",
    ]);
    const f = facts(a);
    expect(f.Tpl).toEqual(["definition -"]);
    expect(f["Box.Put"]).toEqual(["declaration -", "definition -"]);
    expect(f.Hidden).toEqual(["definition -"]);
    expect(f.Anon).toEqual(["definition -"]);
    expect(f["Y.Peer"]).toEqual(["declaration -"]);
    expect(f["Y.Y"]).toEqual(["definition -", "definition -"]);
    expect(f["Y.Inline"]).toEqual(["definition ()"]);
  });

  it("other languages have no callable facts", () => {
    expect(analyze("src/a.ts", ["export function f(x: number): number { return x; }"]).symbols.some((s) => s.callables !== undefined)).toBe(false);
    expect(analyze("src/A.java", ["class A { void f(int x) {} }"]).symbols.some((s) => s.callables !== undefined)).toBe(false);
  });
});

