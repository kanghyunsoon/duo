import { readFileSync } from "node:fs";
import { compareUtf8, fileRef, nodeId, type RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { openNodeSqliteGraphStore } from "./store/node-sqlite/node-sqlite-graph-store.js";
import { traverse } from "./traverse.js";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/core/ordering.json", import.meta.url), "utf8")) as {
  readonly input: readonly string[];
  readonly expected: readonly string[];
};

describe("UTF-8 ordering is the same in SQLite and JavaScript (T04)", () => {
  const refs = fixture.input.map((s) => fileRef(s as RepoPath));
  const expectedIds = fixture.expected.map((s) => nodeId(fileRef(s as RepoPath)));

  it("listNodes (SQLite BINARY) and compareUtf8 give the fixture order", () => {
    const store = openNodeSqliteGraphStore({ path: ":memory:" }).value;
    if (store === undefined) throw new Error("open failed");
    try {
      store.upsertNodes(refs.map((ref) => ({ ref })));
      const listed = store.listNodes({ limit: 100 }).map((n) => n.id);
      expect(listed).toEqual(expectedIds);
      expect(store.getNodes(refs).map((n) => n.id)).toEqual(expectedIds);
      expect([...listed].sort(compareUtf8)).toEqual(listed);
      // The default JS order differs for these IDs, which is why a shared comparator exists.
      expect([...listed].sort()).not.toEqual(listed);
    } finally {
      store.close();
    }
  });

  it("traverse orders same-depth nodes like SQLite", () => {
    const store = openNodeSqliteGraphStore({ path: ":memory:" }).value;
    if (store === undefined) throw new Error("open failed");
    try {
      const hub = fileRef("hub" as RepoPath);
      store.upsertNodes([{ ref: hub }, ...refs.map((ref) => ({ ref }))]);
      store.upsertEdges(refs.map((to) => ({ from: hub, type: "IMPORTS" as const, to })));
      const result = traverse(store, [hub], { maxDepth: 1, nodeLimit: 100, direction: "outgoing" });
      expect(result.nodes.filter((n) => n.depth === 1).map((n) => n.node.id)).toEqual(expectedIds);
      expect(result.edges.map((e) => e.to)).toEqual(expectedIds);
    } finally {
      store.close();
    }
  });
});
