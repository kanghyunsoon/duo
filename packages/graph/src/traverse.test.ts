import { definitionRef, fileRef, symbolRef, type RepoPath } from "@duo-director/core";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteGraphStore } from "./store/node-sqlite/node-sqlite-graph-store.js";
import type { GraphEdgeInput, GraphNodeInput, GraphStore } from "./store/types.js";
import { traverse } from "./traverse.js";

const stores: GraphStore[] = [];
afterEach(() => { while (stores.length) stores.pop()?.close(); });

const req = (id: string) => definitionRef("requirement", id);
const dec = (id: string) => definitionRef("decision", id);
const f = fileRef("src/a.ts" as RepoPath);
const s = (name: string) => symbolRef("src/a.ts" as RepoPath, name);

//  D-1 ─GOVERNS→ REQ-A-1 ←IMPLEMENTS─ a ─CALLS→ b ─CALLS→ c ─CALLS→ d
//                                     f ─CONTAINS→ a, b, c, d
const nodes: GraphNodeInput[] = [dec("D-1"), req("REQ-A-1"), f, s("a"), s("b"), s("c"), s("d")].map((ref) => ({ ref }));
const edges: GraphEdgeInput[] = [
  { from: dec("D-1"), type: "GOVERNS", to: req("REQ-A-1") },
  { from: s("a"), type: "IMPLEMENTS", to: req("REQ-A-1") },
  { from: s("a"), type: "CALLS", to: s("b") },
  { from: s("b"), type: "CALLS", to: s("c") },
  { from: s("c"), type: "CALLS", to: s("d") },
  ...["a", "b", "c", "d"].map((n) => ({ from: f, type: "CONTAINS" as const, to: s(n) })),
];

function graph(order: "forward" | "reverse" = "forward"): GraphStore {
  const store = openNodeSqliteGraphStore({ path: ":memory:" }).value;
  if (!store) throw new Error("open failed");
  stores.push(store);
  store.transaction((tx) => {
    tx.upsertNodes(order === "forward" ? nodes : [...nodes].reverse());
    tx.upsertEdges(order === "forward" ? edges : [...edges].reverse());
  });
  return store;
}

const ids = (r: ReturnType<typeof traverse>) => r.nodes.map((n) => `${n.depth}:${n.node.id}`);

describe("AC-003-02 traverse", () => {
  it("respects maxDepth and direction", () => {
    const r = traverse(graph(), [s("a")], { maxDepth: 2, nodeLimit: 100, direction: "outgoing" });
    expect(ids(r)).toEqual(["0:sym:src/a.ts#a", "1:req:REQ-A-1", "1:sym:src/a.ts#b", "2:sym:src/a.ts#c"]);
    expect(r.truncated).toBe(false);
    expect(r.edges.map((e) => e.type)).toEqual(["CALLS", "IMPLEMENTS", "CALLS"]);
  });

  it("respects edgeTypes", () => {
    const r = traverse(graph(), [req("REQ-A-1")], { maxDepth: 3, nodeLimit: 100, direction: "incoming", edgeTypes: ["GOVERNS"] });
    expect(ids(r)).toEqual(["0:req:REQ-A-1", "1:dec:D-1"]);
  });

  it("stops at nodeLimit deterministically and reports truncation", () => {
    const r = traverse(graph(), [s("b")], { maxDepth: 3, nodeLimit: 3, direction: "both" });
    expect(ids(r)).toEqual(["0:sym:src/a.ts#b", "1:file:src/a.ts", "1:sym:src/a.ts#a"]);
    expect(r.truncated).toBe(true);
  });

  it("returns the same result for any insertion order", () => {
    const options = { maxDepth: 3, nodeLimit: 5, direction: "both" } as const;
    expect(traverse(graph("reverse"), [s("c")], options)).toEqual(traverse(graph("forward"), [s("c")], options));
  });

  it("ignores seeds that are not in the store and handles depth 0", () => {
    const r = traverse(graph(), [req("REQ-MISSING-1"), s("a")], { maxDepth: 0, nodeLimit: 10, direction: "both" });
    expect(ids(r)).toEqual(["0:sym:src/a.ts#a"]);
    expect(r.edges).toEqual([]);
  });

  it("reports truncation when a level has more edges than edgeLimitPerLevel", () => {
    const r = traverse(graph(), [f], { maxDepth: 1, nodeLimit: 100, direction: "outgoing", edgeLimitPerLevel: 2 });
    expect(r.truncated).toBe(true);
    expect(r.nodes).toHaveLength(3);
  });
});
