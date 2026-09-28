import fs from "node:fs";
import { nodeId, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyzerRegistry } from "../registry.js";
import type { SourceAnalysis } from "../types.js";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";

const FIXTURES = new URL("../../../../../fixtures/analyzer/", import.meta.url);

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const r = await createDefaultAnalyzerRegistry();
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  registry = r.value;
});
afterAll(() => registry.dispose());

function analyzeWithDiagnostics(name: string, text?: string) {
  return registry.analyze({ path: name as RepoPath, content: text === undefined ? fs.readFileSync(new URL(name, FIXTURES)) : Buffer.from(text) });
}
function analyze(name: string, text?: string): SourceAnalysis {
  const r = analyzeWithDiagnostics(name, text);
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
const tests = (a: SourceAnalysis) => a.tests.map((t) => [t.fullName, t.kind, t.frameworkHint, t.confidence, t.modifier ?? null]);

describe("test definitions (T05.1)", () => {
  it("Vitest explicit imports, aliases, namespace, nested suites, skip/only/todo", () => {
    const a = analyze("auth.vitest.ts");
    expect(tests(a)).toEqual([
      ["Auth", "suite", "vitest", "explicit", null],
      ["Auth > Refresh", "suite", "vitest", "explicit", null],
      ["Auth > Refresh > expires", "test", "vitest", "explicit", null],
      ["Auth > Refresh > renews", "test", "vitest", "explicit", "skip"],
      ["Auth > focused", "test", "vitest", "explicit", "only"],
      ["Auth > later", "test", "vitest", "explicit", "todo"],
      ["Auth > static template", "test", "vitest", "explicit", null],
      ["through namespace", "test", "vitest", "explicit", null],
      ["registered", "test", "vitest", "explicit", null],
    ]);
    expect(a.tests.find((t) => t.fullName === "Auth > Refresh > expires")).toMatchObject({ name: "expires", enclosingSuite: "Auth > Refresh" });
    // A test call inside an extracted symbol records it; VALIDATED_BY is TASK-007.
    expect(a.tests.find((t) => t.name === "registered")?.enclosingSymbol?.symbol).toBe("registerTests");
    expect(a.tests.every((t) => t.name !== "not imported here")).toBe(true);
  });

  it("does not invent names for dynamic tests and suites", () => {
    const r = analyzeWithDiagnostics("auth.vitest.ts");
    const names = r.value?.tests.map((t) => t.name) ?? [];
    expect(names).not.toContain("hidden by dynamic suite");
    expect(r.diagnostics.map((d) => [d.code, d.source?.startLine])).toEqual([
      ["TEST_NAME_DYNAMIC", 12], ["TEST_NAME_DYNAMIC", 13], ["TEST_NAME_DYNAMIC", 17],
    ]);
  });

  it("Jest and node:test explicit imports", () => {
    expect(tests(analyze("jest.test.js"))).toEqual([
      ["Cart", "suite", "jest", "explicit", null],
      ["Cart > adds", "test", "jest", "explicit", null],
    ]);
    expect(tests(analyze("node-test.mjs"))).toEqual([
      ["top level", "test", "node-test", "explicit", null],
      ["group", "suite", "node-test", "explicit", null],
      ["group > inner", "test", "node-test", "explicit", null],
    ]);
  });

  it("global test/it only in test files, with frameworkHint unknown", () => {
    expect(tests(analyze("globals.test.ts"))).toEqual([
      ["Globals", "suite", "unknown", "heuristic", null],
      ["Globals > works", "test", "unknown", "heuristic", null],
      ["Globals > skipped", "test", "unknown", "heuristic", "skip"],
    ]);
    expect(analyze("globals-source.ts").tests).toEqual([]);
    // The same calls are still call sites.
    expect(analyze("globals-source.ts").callSites.map((c) => c.calleeText)).toEqual(["describe", "it"]);
  });

  it("does not treat locally bound names as global test functions", () => {
    expect(tests(analyze("shadow.test.ts"))).toEqual([["global describe still counts", "suite", "unknown", "heuristic", null]]);
  });

  it("names are identity material; positions are not", () => {
    const a = analyze("globals.test.ts");
    const moved = analyze("globals.test.ts", "\n\n" + fs.readFileSync(new URL("globals.test.ts", FIXTURES), "utf8"));
    expect(moved.tests.map((t) => t.fullName)).toEqual(a.tests.map((t) => t.fullName));
    expect(moved.tests[0]?.location.startLine).toBe(3);
  });
});

describe("import bindings (T05.1)", () => {
  it("records local → imported bindings for ESM, import = require and CommonJS require", () => {
    const refs = analyze("imports.ts").moduleReferences;
    const bindings = Object.fromEntries(refs.filter((m) => m.kind !== "export-from").map((m) => [m.specifier, m.bindings.map((b) => [b.local, b.imported, b.typeOnly])]));
    expect(bindings).toEqual({
      "./foo": [["foo", "default", false]],
      "./bar": [["bar", "bar", false]],
      "./baz": [["qux", "baz", false]],
      "./ns": [["Ns", "*", false]],
      "./types": [["T", "T", true]],
      "./mixed": [["U", "U", true], ["value", "value", false]],
      "./many": [["def", "default", false], ["named", "named", false], ["xy", "x-y", false], ["other", "default", false]],
      "./side-effect": [],
      "./legacy": [["Legacy", "*", false]],
      "./cjs": [["Cjs", "*", false]],
      "./destructured": [["a", "a", false], ["renamed", "b", false], ["Dflt", "default", false]],
      "./bare": [],
    });
    expect(refs.find((m) => m.specifier === "./types")?.typeOnly).toBe(true);
    expect(refs.find((m) => m.specifier === "./mixed")?.typeOnly).toBe(false);
  });

  it("keeps re-exports separate from local bindings", () => {
    const refs = analyze("imports.ts").moduleReferences.filter((m) => m.kind === "export-from");
    expect(refs.map((m) => [m.specifier, m.bindings, m.reexports.map((r) => [r.exported, r.imported, r.typeOnly])])).toEqual([
      ["./foo2", [], [["foo2", "foo2", false]]],
      ["./foo3", [], [["bar3", "foo3", false]]],
      ["./all", [], [["*", "*", false]]],
      ["./grouped", [], [["grouped", "*", false]]],
      ["./vtypes", [], [["V", "V", true]]],
    ]);
  });
});

describe("static / instance member identity (T05.1)", () => {
  it("static and instance members with the same name are different symbols", () => {
    const a = analyze("members.ts");
    expect(a.symbols.map((s) => [nodeId(s.ref), s.qualifiedName, s.kind, s.memberScope ?? null])).toEqual([
      ["sym:members.ts#User", "User", "class", null],
      ["sym:members.ts#User.static.load", "User.load", "method", "static"],
      ["sym:members.ts#User.load", "User.load", "method", "instance"],
      ["sym:members.ts#User.static.name", "User.name", "getter", "static"],
      ["sym:members.ts#User.name", "User.name", "accessor", "instance"],
      ["sym:members.ts#User.static.%23count", "User.#count", "method", "static"],
      ["sym:members.ts#User.%23count", "User.#count", "method", "instance"],
      ['sym:members.ts#User["a.b"]', "User.a.b", "method", "instance"],
      ['sym:members.ts#User.static["a.b"]', "User.a.b", "method", "static"],
    ]);
    // A getter/setter pair merges only within one scope; static "load" (a string name) is the same property as static load.
    expect(a.symbols.find((s) => nodeId(s.ref) === "sym:members.ts#User.name")?.additionalLocations?.map((l) => l.startLine)).toEqual([7]);
    expect(a.symbols.find((s) => nodeId(s.ref) === "sym:members.ts#User.static.load")?.additionalLocations?.map((l) => l.startLine)).toEqual([14]);
    expect(new Set(a.symbols.map((s) => nodeId(s.ref))).size).toBe(a.symbols.length);
  });
});
