/**
 * C226 (T24.4): the Python effective definition through the real Indexer. While definitions are added,
 * removed, reordered, decorated and turned into typing.overload stubs, the Symbol keeps its ID, its
 * primary location follows the rule, every definition stays a location, and incremental index == clean
 * full rebuild (no stale primary). An annotation attaches to the Symbol at any of its definitions.
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const TRUTH: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: py-defs\n",
  ".duo-project/specs/py.md": "# Py\n\n## PY-01 Values\n\n```duo\nstatus: planned\npriority: must\n```\n\nValues.\n",
};
const FILE = "pkg/mod.py";

async function index(repo: TestRepo, store: GraphStore) {
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}

/** Start lines of the Symbol: [primary, other locations]. */
function layout(store: GraphStore, symbol: string): [number | undefined, number[]] {
  const n = store.getNode({ type: "symbol", path: FILE, symbol } as never);
  const extra = (n?.payload.additionalLocations ?? []) as { startLine: number }[];
  return [n?.source?.startLine, extra.map((l) => l.startLine)];
}
/** 1-based line of the exact line text (the start of the definition expected to be primary). */
const lineOf = (lines: readonly string[], text: string) => lines.indexOf(text) + 1;

const ORDINARY = ["def foo(a):", "    return 1", "", "def foo(b):", "    return 2", ""];
const STUBS = ["from typing import overload", "", "@overload", "def foo(a: int) -> int: ...", "", "@overload", "def foo(a: str) -> str: ...", ""];
const IMPL = ["def foo(a):", "    return a", ""];

describe("Python effective definition through the Indexer (C226)", () => {
  it("incremental index equals a clean full rebuild while definitions change; the primary follows the rule", async () => {
    const repo = makeRepo(temps, { ...TRUTH, [FILE]: "def foo(a):\n    return 1\n" });
    const store = memoryStore();
    try {
      await index(repo, store);
      expect(layout(store, "foo")).toEqual([1, []]);
      // [label, file lines, line text of the expected primary, number of other locations]
      const steps: [string, string[], string, number][] = [
        ["add a second ordinary definition", ORDINARY, "def foo(b):", 1],
        ["edit only the body", ORDINARY.map((l) => (l === "    return 2" ? "    return 22" : l)), "def foo(b):", 1],
        ["reorder the definitions", ["def foo(b):", "    return 2", "", "def foo(a):", "    return 1", ""], "def foo(a):", 1],
        ["remove the second definition", ["def foo(a):", "    return 1", ""], "def foo(a):", 0],
        ["ordinary definition becomes @overload + implementation", [...STUBS.slice(0, 5), ...IMPL], "def foo(a):", 1],
        ["add an overload stub", [...STUBS, ...IMPL], "def foo(a):", 2],
        ["remove the implementation", STUBS, "@overload", 1],
        ["add the implementation back", [...STUBS, ...IMPL], "def foo(a):", 2],
        ["remove an overload stub", [...STUBS.slice(0, 5), ...IMPL], "def foo(a):", 1],
        ["remove the overload decorator (an ordinary redefinition again)", ["from typing import overload", "", "def foo(a: int) -> int: ...", "", ...IMPL], "def foo(a):", 1],
        ["add another decorator: no guess", ["@cache", ...ORDINARY], "@cache", 1],
        ["remove the decorator", ORDINARY, "def foo(b):", 1],
      ];
      for (const [label, lines, primary, others] of steps) {
        repo.write(FILE, lines.join("\n"));
        const r = await index(repo, store);
        expect(r.mode, label).toBe("incremental");
        const [start, extra] = layout(store, "foo");
        expect(start, label).toBe(lineOf(lines, primary));
        expect(extra.length, label).toBe(others);
        expect(dumpGraph(store), label).toEqual(await cleanRebuild(repo.root, base, 500));
      }
    } finally {
      store.close();
    }
  });

  it("an annotation at any definition attaches to the Symbol, whichever definition is primary", async () => {
    const repo = makeRepo(temps, {
      ...TRUTH,
      [FILE]: [
        "from typing import overload", "", "# duo: PY-01", "@overload", "def foo(x: int) -> int: ...", "", "def foo(x):", "    return x", "",
        "def bar():", "    return 1", "", "# duo: PY-01", "def bar():", "    return 2", "",
      ].join("\n"),
    });
    const store = memoryStore();
    try {
      await index(repo, store);
      expect(layout(store, "foo")).toEqual([7, [4]]);
      expect(layout(store, "bar")).toEqual([14, [10]]);
      expect(edge(store, "sym:pkg/mod.py#foo", "IMPLEMENTS", "req:PY-01")).toBeDefined();
      expect(edge(store, "sym:pkg/mod.py#bar", "IMPLEMENTS", "req:PY-01")).toBeDefined();
      expect(edge(store, "file:pkg/mod.py", "IMPLEMENTS", "req:PY-01")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

