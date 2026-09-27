import fs from "node:fs";
import { canonicalSourceText, compareUtf8, nodeId, sliceSource, sliceSourceLocation, symbolRef, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeContentHash } from "../../fingerprint/content-hash.js";
import type { AnalyzerRegistry } from "../registry.js";
import type { SourceAnalysis } from "../types.js";
import { createDefaultAnalyzerRegistry, createTypeScriptAnalyzer } from "./ts-js-analyzer.js";

const FIXTURES = new URL("../../../../../fixtures/analyzer/", import.meta.url);
const p = (s: string) => s as RepoPath;
const source = (name: string) => fs.readFileSync(new URL(name, FIXTURES), "utf8");

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const r = await createDefaultAnalyzerRegistry();
  expect(r.diagnostics).toEqual([]);
  if (r.value === undefined) throw new Error("no registry");
  registry = r.value;
});
afterAll(() => registry.dispose());

function analyzeText(path: string, text: string) {
  return registry.analyze({ path: p(path), content: Buffer.from(text, "utf8") });
}
function analyze(name: string): SourceAnalysis {
  const r = analyzeText(name, source(name));
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);
const calls = (a: SourceAnalysis) => a.callSites.map((c) => [c.kind, c.calleeText, c.enclosingSymbol?.symbol ?? null, c.location.startLine]);

describe("extension ↔ grammar", () => {
  it.each([
    ["component.tsx", "tsx"], ["symbols.ts", "typescript"], ["module.mts", "typescript"], ["common.cts", "typescript"],
    ["widget.jsx", "javascript"], ["esm.mjs", "javascript"], ["legacy.cjs", "javascript"], ["default-class.js", "javascript"],
  ])("%s → %s, complete parse", (name, language) => {
    const a = analyze(name);
    expect(a.language).toBe(language);
    expect(a.parseStatus).toBe("complete");
  });

  it("does not analyze Project Truth, Markdown, YAML or unknown files, and does not parse them", () => {
    for (const path of [".duo-project/project.yaml", "docs/guide.md", "README", "config.json", "a.d.ts.map"]) {
      expect(registry.analyzerFor(p(path))).toBeUndefined();
    }
    // Invalid UTF-8 would be SOURCE_DECODE_ERROR if the file were decoded or parsed.
    const r = registry.analyze({ path: p("notes.md"), content: new Uint8Array([0xff, 0xfe, 0xfd]) });
    expect(codes(r)).toEqual(["LANGUAGE_UNSUPPORTED"]);
  });
});

describe("symbols", () => {
  it("extracts declarations and class members with qualified names", () => {
    const a = analyze("symbols.ts");
    expect(a.symbols.map((s) => [s.qualifiedName, s.kind, s.exported, s.location.startLine])).toEqual([
      ["Session", "interface", true, 4],
      ["SessionId", "type-alias", true, 8],
      ["Role", "enum", true, 10],
      ["Login", "function", true, 17],
      ["legacy", "function", true, 21],
      ["parse", "function", true, 28],
      ["declared", "function", true, 32],
      ["Base", "class", true, 34],
      ["Base.run", "method", true, 35],
      ["AuthService", "class", true, 38],
      ["AuthService.constructor", "constructor", true, 42],
      ["AuthService.token", "accessor", true, 46],
      ["AuthService.create", "method", true, 54],
      ["AuthService.login", "method", true, 60],
      ["AuthService.#refresh", "method", true, 64],
      ["AuthService.run", "method", true, 68],
      ["AuthService.quoted-name", "method", true, 70],
      ["Internal", "class", true, 75],
    ]);
    // Not symbols: the constant TIMEOUT, the nested function, class fields, the computed [Symbol.iterator].
    const names = a.symbols.map((s) => s.qualifiedName);
    for (const absent of ["TIMEOUT", "nested", "legacy.nested", "AuthService.instances", "AuthService.#token"]) expect(names).not.toContain(absent);
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.create")).toMatchObject({ memberScope: "static", parent: "AuthService" });
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.create")?.ref.symbol).toBe("AuthService.static.create");
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.quoted-name")?.ref.symbol).toBe('AuthService["quoted-name"]');
  });

  it("uses core symbolRef/nodeId as identity", () => {
    const refresh = analyze("symbols.ts").symbols.find((s) => s.qualifiedName === "AuthService.#refresh");
    expect(refresh?.ref).toEqual(symbolRef(p("symbols.ts"), "AuthService.#refresh"));
    expect(nodeId(refresh?.ref ?? symbolRef(p("x"), "x"))).toBe("sym:symbols.ts#AuthService.%23refresh");
  });

  it("merges TypeScript overloads into one symbol; the implementation is the primary location", () => {
    const a = analyze("symbols.ts");
    const parse = a.symbols.filter((s) => s.qualifiedName === "parse");
    expect(parse).toHaveLength(1);
    expect(parse[0]?.location).toMatchObject({ startLine: 28 });
    expect(parse[0]?.additionalLocations?.map((l) => l.startLine)).toEqual([26, 27]);
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.login")?.additionalLocations?.map((l) => l.startLine)).toEqual([58, 59]);
    // A getter and setter pair is one property symbol.
    expect(a.symbols.find((s) => s.qualifiedName === "AuthService.token")?.additionalLocations?.map((l) => l.startLine)).toEqual([50]);
  });

  it("uses the first declaration when no overload has a body", () => {
    const a = analyzeText("sig.ts", "declare function f(a: string): void;\ndeclare function f(a: number): void;\n").value;
    expect(a?.symbols.map((s) => [s.qualifiedName, s.location.startLine, s.additionalLocations?.map((l) => l.startLine)])).toEqual([["f", 1, [2]]]);
  });

  it("names anonymous default exports 'default', independent of position", () => {
    const fn = analyze("default-function.ts");
    expect(fn.symbols.map((s) => [s.qualifiedName, s.kind, s.exported])).toEqual([["default", "function", true]]);
    expect(calls(fn)).toEqual([["identifier", "run", "default", 2]]);
    const moved = analyzeText("default-function.ts", "// moved\n\n" + source("default-function.ts")).value;
    expect(moved?.symbols.map((s) => nodeId(s.ref))).toEqual(fn.symbols.map((s) => nodeId(s.ref)));
    expect(moved?.symbols[0]?.location.startLine).toBe(3);

    const cls = analyze("default-class.js");
    expect(cls.symbols.map((s) => [s.qualifiedName, s.kind])).toEqual([["default", "class"], ["default.render", "method"]]);
    expect(analyze("esm.mjs").symbols.map((s) => [s.qualifiedName, s.kind])).toEqual([["default", "function"]]);
  });

  it("marks local export lists and default identifiers as exported", () => {
    const a = analyzeText("e.ts", "function f() {}\nfunction g() {}\nclass C { m() {} }\nexport { f };\nexport default C;\n").value;
    expect(a?.symbols.map((s) => [s.qualifiedName, s.exported])).toEqual([["f", true], ["g", false], ["C", true], ["C.m", true]]);
  });
});

describe("module references", () => {
  it("records literal specifiers without resolving them", () => {
    const a = analyze("modules.ts");
    expect(a.moduleReferences.map((m) => [m.specifier, m.kind, m.typeOnly])).toEqual([
      ["./a", "import", false],
      ["./c", "import", true],
      ["./side-effect", "import", false],
      ["node:path", "import", false],
      ["pkg", "import", false],
      ["./x", "export-from", false],
      ["./y", "export-from", true],
      ["./all", "export-from", false],
      ["./grouped", "export-from", false],
      ["./legacy", "require", false],
      ["./lazy", "dynamic-import", false],
      ["./cjs", "require", false],
    ]);
    expect(sliceSourceLocation(source("modules.ts"), a.moduleReferences[0]?.location ?? { path: "" })).toBe('import { a, type B } from "./a";');
    // require(name) is not literal: only a call site. import(`./t`) is neither.
    expect(calls(a)).toEqual([["identifier", "require", null, 13]]);
  });

  it("covers every extension", () => {
    expect(analyze("module.mts").moduleReferences.map((m) => [m.specifier, m.kind])).toEqual([["./x.mjs", "dynamic-import"]]);
    expect(analyze("common.cts").moduleReferences.map((m) => [m.specifier, m.kind])).toEqual([["node:fs", "require"]]);
    expect(analyze("esm.mjs").moduleReferences.map((m) => [m.specifier, m.kind])).toEqual([["./a.mjs", "import"]]);
    expect(analyze("legacy.cjs").moduleReferences.map((m) => [m.specifier, m.kind])).toEqual([["node:path", "require"]]);
    expect(analyze("component.tsx").moduleReferences.map((m) => m.specifier)).toEqual(["react"]);
  });
});

describe("call sites", () => {
  it("records calls as written, with the enclosing symbol, and resolves nothing", () => {
    expect(calls(analyze("calls.ts"))).toEqual([
      ["identifier", "b", "a", 4],
      ["identifier", "a", "run", 10],
      ["member", "helper.util.go", "run", 11],
      ["constructor", "AuthService", "run", 12],
      ["member", "service.login", "run", 13],
      ["identifier", "b", "run", 15],
      ["member", "items.forEach", "run", 16],
      ["identifier", "format", "run", 16],
      ["identifier", "setup", "Widget", 20],
      ["member", "this.draw", "Widget.render", 23],
      ["member", "super.render", "Widget.render", 24],
      ["identifier", "top", null, 28],
      ["constructor", "Map", null, 29],
      ["identifier", "tag", null, 30],
    ]);
  });

  it("covers TSX, JSX and CommonJS", () => {
    expect(calls(analyze("component.tsx"))).toEqual([["identifier", "track", "Button", 4]]);
    expect(calls(analyze("widget.jsx"))).toEqual([["identifier", "format", "Widget", 1]]);
    expect(calls(analyze("common.cts"))).toEqual([["member", "fs.readFileSync", "read", 4]]);
    expect(calls(analyze("legacy.cjs"))).toEqual([["member", "path.join", null, 4]]);
  });
});

describe("DUO annotations", () => {
  it("reads line and block comments only, never strings", () => {
    const text = source("annotations.ts");
    const r = analyzeText("annotations.ts", text);
    const a = r.value;
    expect(a?.annotations.map((n) => [n.ids, n.location.startLine])).toEqual([
      [["AUTH-03"], 1],
      [["AUTH-04", "AUTH-05"], 5],
      [["GAME-42"], 9],
      [["AUTH-06"], 17],
      [["AUTH-07"], 19],
    ]);
    expect(a?.annotations.map((n) => sliceSourceLocation(text, n.location))).toEqual([
      "duo: AUTH-03", "duo: AUTH-04, AUTH-05", "duo: GAME-42", "duo:AUTH-06", "duo: AUTH-07 — 로그인 보조",
    ]);
    const all = a?.annotations.flatMap((n) => n.ids) ?? [];
    expect(all).not.toContain("AUTH-99");
    expect(all).not.toContain("AUTH-98");
    expect(all).not.toContain("AUTH-97");
    expect(r.diagnostics.map((d) => [d.code, d.source?.startLine])).toEqual([["DUO_ANNOTATION_INVALID", 16]]);
  });
});

describe("partial parse", () => {
  it("keeps extracting outside the error and marks the analysis partial", () => {
    const r = analyzeText("broken.ts", source("broken.ts"));
    expect(r.value?.parseStatus).toBe("partial");
    expect(codes(r)).toEqual(["AST_PARSE_ERROR"]);
    expect(r.diagnostics[0]?.source).toMatchObject({ startLine: 2 });
    const names = r.value?.symbols.map((s) => s.qualifiedName) ?? [];
    expect(names).toEqual(expect.arrayContaining(["ok", "After", "After.m"]));
    expect(r.value?.callSites.map((c) => c.calleeText)).toEqual(expect.arrayContaining(["call", "later"]));
  });

  it("recovers after a local error", () => {
    const r = analyzeText("err.ts", "const x = ;\nexport function fine() { ok(); }\n");
    expect(r.value?.parseStatus).toBe("partial");
    expect(r.value?.symbols.map((s) => s.qualifiedName)).toEqual(["fine"]);
    expect(calls(r.value as SourceAnalysis)).toEqual([["identifier", "ok", "fine", 2]]);
  });

  it("does not read inside ERROR nodes", () => {
    // Tree-sitter wraps this whole input in ERROR; the calls and function inside are not reported.
    const r = analyzeText("err.ts", "@@@ foo(); class {{{ bar();\nexport function fine() { ok(); }\n");
    expect(r.value?.parseStatus).toBe("partial");
    expect(r.value?.symbols).toEqual([]);
    expect(r.value?.callSites).toEqual([]);
    expect(codes(r)).toContain("AST_PARSE_ERROR");
  });
});

describe("SourceLocation (UTF-16 columns, CRLF)", () => {
  it("locates 한글 and emoji exactly", () => {
    const text = source("unicode.ts");
    const a = analyze("unicode.ts");
    expect(a.symbols.map((s) => s.qualifiedName)).toEqual(["인사", "사용자", "사용자.이름변경"]);
    expect(sliceSourceLocation(text, a.symbols[0]?.location ?? { path: "" })).toBe("인사 = (이름: string) => `안녕 ${이름} 😀`");
    const [log, show] = a.callSites;
    expect(sliceSourceLocation(text, log?.location ?? { path: "" })).toBe('로그("😀", 새이름)');
    // "/* 😀😀 */ " is 11 UTF-16 code units (15 UTF-8 bytes, 9 code points).
    expect(show?.location).toEqual({ path: "unicode.ts", startLine: 8, startColumn: 12, endLine: 8, endColumn: 16 });
  });

  it("gives a CRLF checkout the same analysis and slices", () => {
    for (const name of ["unicode.ts", "symbols.ts", "annotations.ts", "calls.ts"]) {
      const lf = source(name);
      const crlf = lf.replace(/\n/g, "\r\n");
      const a = analyzeText(name, lf);
      const b = analyzeText(name, crlf);
      expect(b).toEqual(a);
      // The same location covers the same text; a multi-line slice keeps the checkout's CR.
      for (const s of a.value?.symbols ?? []) expect(sliceSourceLocation(crlf, s.location)?.replace(/\r\n/g, "\n")).toBe(sliceSourceLocation(lf, s.location));
    }
  });

  it("addresses the canonical text: a leading BOM is not a column (T09.1)", () => {
    const text = "\uFEFFexport function a() { b(); }\n";
    const a = analyzeText("bom.ts", text).value;
    expect(a?.parseStatus).toBe("complete");
    expect(a?.symbols[0]?.location).toMatchObject({ startLine: 1, startColumn: 8 });
    expect(sliceSource(canonicalSourceText(text), a?.symbols[0]?.location ?? { path: "" }).value).toBe("function a() { b(); }");
  });
});

describe("contract details", () => {
  it("contentHash equals the fingerprint contentHash", () => {
    const bytes = fs.readFileSync(new URL("symbols.ts", FIXTURES));
    expect(analyze("symbols.ts").contentHash).toBe(computeContentHash(bytes, "normalized-text").contentHash);
  });

  it("rejects invalid UTF-8", () => {
    const r = registry.analyze({ path: p("bad.ts"), content: new Uint8Array([0x63, 0xff, 0x3b]) });
    expect(codes(r)).toEqual(["SOURCE_DECODE_ERROR"]);
  });

  it("orders every list by location, then a stable key", () => {
    const a = analyze("calls.ts");
    const keys = a.callSites.map((c) => [c.location.startLine, c.location.startColumn]);
    expect(keys).toEqual([...keys].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0)));
  });

  it("stops at the parse time limit and keeps working afterwards", async () => {
    const analyzer = (await createTypeScriptAnalyzer({ parseTimeoutMs: 0 })).value;
    if (analyzer === undefined) throw new Error("no analyzer");
    try {
      const big = "a();\n".repeat(200_000);
      expect(codes(analyzer.analyze({ path: p("big.ts"), content: Buffer.from(big) }))).toEqual(["AST_PARSE_TIMEOUT"]);
    } finally {
      analyzer.dispose();
    }
    expect(() => analyzer.analyze({ path: p("a.ts"), content: new Uint8Array() })).toThrow(/disposed/);
  });
});

describe("cross-platform golden", () => {
  it("fixture analyses match expected.json on every OS", () => {
    const names = fs.readdirSync(FIXTURES).filter((f) => registry.analyzerFor(p(f)) !== undefined).sort(compareUtf8);
    const actual = Object.fromEntries(names.map((n) => {
      const r = analyzeText(n, source(n));
      return [n, { analysis: r.value, diagnostics: r.diagnostics }];
    }));
    const golden = new URL("expected.json", FIXTURES);
    if (process.env.DUO_UPDATE_GOLDEN === "1") fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + "\n");
    expect(actual).toEqual(JSON.parse(fs.readFileSync(golden, "utf8")));
  });
});
