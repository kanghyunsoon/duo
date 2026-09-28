/**
 * AC-005-01: the WASM grammars shipped in the official packages load into this web-tree-sitter
 * build and parse. Runs on every CI OS; an ABI mismatch fails here first.
 */
import { describe, expect, it } from "vitest";
import { createParser, loadGrammars, runtimeAbiRange, type GrammarId } from "./runtime.js";

const MINIMAL: Record<GrammarId, string> = {
  typescript: "const a: number = 1;\n",
  tsx: "const b = <div id=\"x\">{a}</div>;\n",
  javascript: "const c = () => <span />;\n",
  java: "class A { void m() { f(); } }\n",
  csharp: "namespace N { class A { void M() { F(); } } }\n",
  cpp: "namespace n { class A { void m(); }; }\nvoid f() { g(); }\n",
  python: "class A:\n    def m(self):\n        return f()\n",
};
const ROOT: Record<GrammarId, string> = {
  typescript: "program", tsx: "program", javascript: "program", java: "program", csharp: "compilation_unit", cpp: "translation_unit", python: "module",
};

describe("grammar smoke test (AC-005-01, T18.0)", () => {
  for (const id of ["typescript", "tsx", "javascript", "java", "csharp", "cpp", "python"] as const) {
    it(`${id}: Parser.init, Language.load, minimal parse`, async () => {
      const loaded = await loadGrammars([id]);
      expect(loaded.diagnostics).toEqual([]);
      const language = loaded.value?.get(id);
      if (language === undefined) throw new Error("grammar not loaded");
      const { min, max } = runtimeAbiRange();
      expect(language.abiVersion).toBeGreaterThanOrEqual(min);
      expect(language.abiVersion).toBeLessThanOrEqual(max);
      const parser = createParser(language);
      const tree = parser.parse(MINIMAL[id]);
      try {
        expect(tree?.rootNode.type).toBe(ROOT[id]);
        expect(tree?.rootNode.hasError).toBe(false);
      } finally {
        tree?.delete();
        parser.delete();
      }
    });
  }

  it("reports a grammar that is not a valid WASM module as ANALYZER_INIT_FAILED", async () => {
    const r = await loadGrammars(["typescript"], () => new Uint8Array([0, 1, 2, 3]));
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(["ANALYZER_INIT_FAILED"]);
    expect(r.diagnostics[0]?.message).toContain("typescript");
  });

  it("reports a missing grammar file as ANALYZER_INIT_FAILED", async () => {
    const r = await loadGrammars(["javascript"], () => { throw new Error("not installed"); });
    expect(r.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["ANALYZER_INIT_FAILED", 'Grammar "javascript" (tree-sitter-javascript/tree-sitter-javascript.wasm) not found: not installed'],
    ]);
  });
});
