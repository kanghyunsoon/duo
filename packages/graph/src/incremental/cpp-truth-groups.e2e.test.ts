/**
 * C231 (T24.5): a Truth qualifiedName reference whose matches are exactly one proven C++ declaration /
 * definition group (T24.3 declaration links of the same run) gets the existing edge to both Symbols.
 * Overload groups, a pair plus another match, no link, other languages and path-narrowed references
 * keep their behavior. Incremental index == clean full rebuild while the evidence changes, and a state
 * written before T24.5 is stale (one index applies the rules).
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, indexStateToken, readIndexState } from "./state.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const inc = (h: string) => `#include "${h}"\n`;
const decision = (id: string, symbols: readonly string[]) => [
  `id: ${id}`, "title: Governs code", "kind: decision", "state: confirmed", "question: q", "answer: a", "owner: human",
  "governs:", `  symbols: [${symbols.map((s) => JSON.stringify(s)).join(", ")}]`, 'confirmed_at: "2026-09-27T00:00:00Z"', "confirmed_by: tester", "",
].join("\n");
const requirement = (id: string, symbols: readonly string[], paths: readonly string[]) => [
  `## ${id} Requirement ${id}`, "", "```duo", "status: planned", "priority: must", "implements:",
  `  symbols: [${symbols.join(", ")}]`, ...(paths.length === 0 ? [] : [`  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]`]), "```", "", "Text.", "",
].join("\n");

const FORMS: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: cpp-truth\n",
  ".duo-project/specs/cpp.md": ["# Cpp", "", requirement("CPP-01", ["Basic.Foo"], ["a/Basic.h"]), requirement("CPP-02", ["Basic.Foo"], ["a/Basic.cpp"]), requirement("CPP-03", ["Basic.Foo"], [])].join("\n"),
  ".duo-project/decisions/D-101.yaml": decision("D-101", ["Basic.Foo"]),
  ".duo-project/decisions/D-102.yaml": decision("D-102", ["Over.Bar"]),
  ".duo-project/decisions/D-103.yaml": decision("D-103", ["Third.Go"]),
  ".duo-project/decisions/D-104.yaml": decision("D-104", ["NoInc.Do"]),
  ".duo-project/decisions/D-105.yaml": decision("D-105", ["dup"]),
  // A: one proven pair.
  "a/Basic.h": "class Basic {\npublic:\n  void Foo(int value);\n};\n", "a/Basic.cpp": inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n",
  // B: two overloads, each a proven pair: one header Symbol and one cpp Symbol, two links.
  "b/Over.h": "class Over {\npublic:\n  void Bar();\n  void Bar(int count);\n};\n", "b/Over.cpp": inc("Over.h") + "void Over::Bar() {}\nvoid Over::Bar(int count) {\n  (void)count;\n}\n",
  // C: a proven pair plus an unpaired declaration with the same qualified name in another header.
  "c/Third.h": "class Third {\npublic:\n  void Go(int v);\n};\n", "c/Third.cpp": inc("Third.h") + "void Third::Go(int v) { (void)v; }\n",
  "c/Other.h": "class Third {\npublic:\n  void Go();\n};\n",
  // H: same qualified name, no include: no link.
  "p/NoInc.h": "class NoInc {\npublic:\n  void Do(int v);\n};\n", "p/NoInc.cpp": "void NoInc::Do(int v) { (void)v; }\n",
  // G: a duplicate qualified name outside C++.
  "py/a.py": "def dup():\n    return 1\n", "py/b.py": "def dup():\n    return 2\n",
};

async function index(repo: TestRepo, store: GraphStore) {
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r;
}
const unresolved = (r: Awaited<ReturnType<typeof index>>) => r.diagnostics.filter((d) => d.code === "DECLARED_SYMBOL_UNRESOLVED").map((d) => d.message).sort();
/** Symbol IDs that dec governs / that implement req. */
const governed = (store: GraphStore, dec: string) => dumpGraph(store).edges.map((e) => JSON.parse(e) as { from: string; type: string; to: string })
  .filter((e) => e.from === dec && e.type === "GOVERNS" && e.to.startsWith("sym:")).map((e) => e.to).sort();
const implementing = (store: GraphStore, req: string) => dumpGraph(store).edges.map((e) => JSON.parse(e) as { from: string; type: string; to: string })
  .filter((e) => e.to === req && e.type === "IMPLEMENTS" && e.from.startsWith("sym:")).map((e) => e.from).sort();

describe("Truth references to proven C++ declaration groups (C231)", () => {
  it("resolves exactly one proven group and keeps every other ambiguity", async () => {
    const repo = makeRepo(temps, FORMS);
    const store = memoryStore();
    try {
      const r = await index(repo, store);
      // A: both members of the one group.
      expect(governed(store, "dec:D-101")).toEqual(["sym:a/Basic.cpp#Basic.Foo", "sym:a/Basic.h#Basic.Foo"]);
      // B, C, H, G: unresolved as before (overloads, a third match, no link, Python).
      for (const d of ["dec:D-102", "dec:D-103", "dec:D-104", "dec:D-105"]) expect(governed(store, d), d).toEqual([]);
      expect(unresolved(r)).toEqual([
        'dec:D-102 governs.symbols "Over.Bar" matches 2 symbols; no edge',
        'dec:D-103 governs.symbols "Third.Go" matches 3 symbols; no edge',
        'dec:D-104 governs.symbols "NoInc.Do" matches 2 symbols; no edge',
        'dec:D-105 governs.symbols "dup" matches 2 symbols; no edge',
      ]);
      // D, E: paths narrow first (one match, unchanged); F: no paths, the group.
      expect(implementing(store, "req:CPP-01")).toEqual(["sym:a/Basic.h#Basic.Foo"]);
      expect(implementing(store, "req:CPP-02")).toEqual(["sym:a/Basic.cpp#Basic.Foo"]);
      expect(implementing(store, "req:CPP-03")).toEqual(["sym:a/Basic.cpp#Basic.Foo", "sym:a/Basic.h#Basic.Foo"]);
      expect(edge(store, "dec:D-101", "GOVERNS", "sym:a/Basic.h#Basic.Foo")?.metadata).toMatchObject({ provenance: "declared", basis: ["governs.symbols"] });
      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
    } finally {
      store.close();
    }
  });

  it("incremental index equals a clean full rebuild while the group evidence changes; no stale edge or finding", async () => {
    const H = "src/Basic.h", C = "src/Basic.cpp";
    const repo = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: evo\n",
      ".duo-project/decisions/D-201.yaml": decision("D-201", ["Basic.Foo"]),
      // A C++ source file, so the registry analyzes the ".h" as C++ (T18.0 header rule).
      "src/main.cpp": "int main() { return 0; }\n",
      [H]: "class Basic {\npublic:\n  void Foo(int value);\n};\n",
    });
    const store = memoryStore();
    try {
      await index(repo, store);
      const header = "sym:src/Basic.h#Basic.Foo", source = "sym:src/Basic.cpp#Basic.Foo";
      expect(governed(store, "dec:D-201")).toEqual([header]);
      const def = inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n";
      // [label, change, governed Symbols, unresolved message or none]
      const steps: [string, () => void, string[], string | undefined][] = [
        ["add the cpp definition: a proven pair", () => repo.write(C, def), [source, header], undefined],
        ["signature mismatch: no pair", () => repo.edit(C, "Foo(int value)", "Foo(long value)"), [], "2 symbols"],
        ["signature restored", () => repo.edit(C, "Foo(long value)", "Foo(int value)"), [source, header], undefined],
        ["add an overload: two pairs", () => { repo.edit(H, "  void Foo(int value);\n", "  void Foo(int value);\n  void Foo();\n"); repo.write(C, def + "void Basic::Foo() {}\n"); }, [], "2 symbols"],
        ["remove the overload", () => { repo.edit(H, "  void Foo();\n", ""); repo.write(C, def); }, [source, header], undefined],
        ["remove the include: no pair", () => repo.write(C, def.replace(inc("Basic.h"), "")), [], "2 symbols"],
        ["restore the include", () => repo.write(C, def), [source, header], undefined],
        ["rename the owner: no match", () => { repo.edit(H, "class Basic", "class Basic2"); repo.write(C, def.replace("Basic::Foo", "Basic2::Foo")); }, [], "no symbol"],
        ["Truth names the new owner", () => repo.write(".duo-project/decisions/D-201.yaml", decision("D-201", ["Basic2.Foo"])), ["sym:src/Basic.cpp#Basic2.Foo", "sym:src/Basic.h#Basic2.Foo"], undefined],
      ];
      for (const [label, change, expected, message] of steps) {
        change();
        const r = await index(repo, store);
        expect(r.value?.mode, label).toBe("incremental");
        expect(governed(store, "dec:D-201"), label).toEqual(expected);
        expect(unresolved(r).map((m) => m.slice(m.indexOf("matches ") + 8, m.indexOf(";"))), label).toEqual(message === undefined ? [] : [message]);
        expect(dumpGraph(store), label).toEqual(await cleanRebuild(repo.root, base, 500));
      }
    } finally {
      store.close();
    }
  });

  it("an index state written before T24.5 is stale; one index applies the rules and is current again", async () => {
    const repo = makeRepo(temps, FORMS);
    const store = memoryStore();
    try {
      await index(repo, store);
      expect((await inspectIndex(repo.root, { graph: store, registry: base })).value?.status).toBe("current");
      // The state as T24.4 wrote it: no relationRulesVersion (token of that content in the state and the graph).
      const state = readIndexState(repo.root).state as unknown as Record<string, unknown>;
      delete state.relationRulesVersion;
      const token = indexStateToken(state as never);
      fs.writeFileSync(path.join(repo.root, INDEX_STATE_FILE_PATH), `${JSON.stringify({ ...state, token })}\n`);
      store.transaction((tx) => tx.writeMeta(INDEX_STATE_TOKEN_KEY, token));
      const before = (await inspectIndex(repo.root, { graph: store, registry: base })).value;
      expect(before?.status).toBe("stale");
      expect(before?.wouldRebuild).toMatchObject({ full: false, parse: [], projectTruth: true });
      const r = await index(repo, store);
      expect(r.value?.mode).toBe("incremental");
      expect((await inspectIndex(repo.root, { graph: store, registry: base })).value?.status).toBe("current");
      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
    } finally {
      store.close();
    }
  });
});

