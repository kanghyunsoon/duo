import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { definitionRef, fileRef, nodeId, symbolRef, type EntityRef, type RepoPath } from "@duo-director/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GraphStoreError, type GraphEdgeInput, type GraphNodeInput, type GraphStore } from "../types.js";
import { openNodeSqliteGraphStore } from "./node-sqlite-graph-store.js";

const temps: string[] = [];
const open: GraphStore[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-graph-"));
  temps.push(dir);
  return path.join(dir, "graph.db");
};
function openStore(file: string, options: Partial<Parameters<typeof openNodeSqliteGraphStore>[0]> = {}): GraphStore {
  const r = openNodeSqliteGraphStore({ path: file, ...options });
  expect(r.diagnostics).toEqual([]);
  if (r.value === undefined) throw new Error("open failed");
  open.push(r.value);
  return r.value;
}

const p = (s: string) => s as RepoPath;
const req = (id: string) => definitionRef("requirement", id);
const dec = (id: string) => definitionRef("decision", id);
const file = (s: string) => fileRef(p(s));
const sym = (f: string, s: string) => symbolRef(p(f), s);

const NODES: GraphNodeInput[] = [
  { ref: req("AUTH-01"), source: { path: ".duo-project/specs/auth.md", startLine: 3, startColumn: 1, endLine: 16, endColumn: 2 }, payload: { title: "Login", status: "done" } },
  { ref: dec("D-004"), contentHash: "sha256:3f1c", payload: { state: "confirmed" } },
  { ref: file("src/auth/AuthService.ts"), contentHash: "sha256:aaa" },
  { ref: sym("src/auth/AuthService.ts", "AuthService.login"), source: { path: "src/auth/AuthService.ts", startLine: 10 }, ownerFile: p("src/auth/AuthService.ts") },
  { ref: sym("src/auth/AuthService.ts", "AuthService.#secret"), ownerFile: p("src/auth/AuthService.ts") },
];
const EDGES: GraphEdgeInput[] = [
  { from: dec("D-004"), type: "GOVERNS", to: req("AUTH-01") },
  { from: sym("src/auth/AuthService.ts", "AuthService.login"), type: "IMPLEMENTS", to: req("AUTH-01"), metadata: { provenance: "declared" } },
  { from: file("src/auth/AuthService.ts"), type: "CONTAINS", to: sym("src/auth/AuthService.ts", "AuthService.login") },
  { from: file("src/auth/AuthService.ts"), type: "CONTAINS", to: sym("src/auth/AuthService.ts", "AuthService.#secret") },
  { from: sym("src/auth/AuthService.ts", "AuthService.login"), type: "CALLS", to: sym("src/auth/AuthService.ts", "AuthService.#secret") },
];

function seed(store: GraphStore, nodes = NODES, edges = EDGES): void {
  store.transaction((tx) => {
    tx.upsertEdges(edges); // edges before nodes: integrity is checked at commit
    tx.upsertNodes(nodes);
  });
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GraphStoreError ? error.code : String(error);
  }
  return "no error";
};

describe.each([["memory", () => ":memory:"], ["file", tempFile]])("AC-003-01 NodeSqliteGraphStore (%s)", (_kind, location) => {
  it("creates an empty graph with graph_schema_version 2", () => {
    const store = openStore(location());
    expect(store.graphSchemaVersion).toBe(2);
    expect(store.counts()).toEqual({ nodes: 0, edges: 0 });
  });

  it("round-trips nodes with source, content hash and payload", () => {
    const store = openStore(location());
    seed(store);
    const node = store.getNode(req("AUTH-01"));
    expect(node).toEqual({
      id: "req:AUTH-01", type: "requirement", ref: req("AUTH-01"),
      source: { path: ".duo-project/specs/auth.md", startLine: 3, startColumn: 1, endLine: 16, endColumn: 2 },
      contentHash: undefined, payload: { status: "done", title: "Login" }, ownerFile: undefined,
    });
    expect(store.getNode(sym("src/auth/AuthService.ts", "AuthService.#secret"))?.id).toBe("sym:src/auth/AuthService.ts#AuthService.%23secret");
    expect(store.getNode(req("AUTH-99"))).toBeUndefined();
    expect(store.counts()).toEqual({ nodes: 5, edges: 5 });
  });

  it("lists the nodes a file owns and keeps graph metadata (schema 2, TASK-008)", () => {
    const store = openStore(location());
    seed(store);
    const owned = store.listNodes({ ownerFile: p("src/auth/AuthService.ts"), limit: 10 }).map((n) => n.id);
    expect(owned).toEqual(["sym:src/auth/AuthService.ts#AuthService.%23secret", "sym:src/auth/AuthService.ts#AuthService.login"]);
    expect(store.listNodes({ ownerFile: p("src/auth/AuthService.ts"), afterId: owned[0]!, limit: 10 }).map((n) => n.id)).toEqual([owned[1]]);
    expect(store.listNodes({ ownerFile: p("src/other.ts"), limit: 10 })).toEqual([]);
    expect(store.getNode(file("src/auth/AuthService.ts"))?.ownerFile).toBeUndefined();
    expect(store.readMeta("graph_schema_version")).toBe("2");
    expect(store.readMeta("graph_revision")).toBeUndefined();
    store.transaction((tx) => tx.writeMeta("graph_revision", "3"));
    expect(store.readMeta("graph_revision")).toBe("3");
    expect(code(() => store.writeMeta("graph_schema_version", "9"))).toBe("INVALID_INPUT");
    expect(code(() => store.writeMeta("Bad Key", "x"))).toBe("INVALID_INPUT");
  });

  it("upserts nodes by id and edges idempotently", () => {
    const store = openStore(location());
    seed(store);
    store.upsertNodes([{ ref: req("AUTH-01"), payload: { title: "Login v2" } }]);
    store.upsertEdges([EDGES[0]!, EDGES[0]!, { ...EDGES[1]!, metadata: { provenance: "static" } }]);
    expect(store.counts()).toEqual({ nodes: 5, edges: 5 });
    expect(store.getNode(req("AUTH-01"))).toMatchObject({ payload: { title: "Login v2" }, source: undefined });
    const implemented = store.adjacentEdges([req("AUTH-01")], { direction: "incoming", types: ["IMPLEMENTS"], limit: 10 });
    expect(implemented.edges.map((e) => e.metadata)).toEqual([{ provenance: "static" }]);
  });

  it("rolls back a transaction whose edge points to a missing node", () => {
    const store = openStore(location());
    seed(store);
    expect(code(() => store.upsertEdges([{ from: req("AUTH-01"), type: "TRACKED_BY", to: definitionRef("issue", "GAME-404") }]))).toBe("CONSTRAINT");
    expect(code(() => store.transaction((tx) => {
      tx.upsertNodes([{ ref: req("AUTH-02") }]);
      throw new Error("abort");
    }))).toContain("abort");
    expect(store.counts()).toEqual({ nodes: 5, edges: 5 });
  });

  it("deletes nodes together with every edge that touches them", () => {
    const store = openStore(location());
    seed(store);
    expect(store.deleteNodes([sym("src/auth/AuthService.ts", "AuthService.login")])).toBe(1);
    expect(store.counts()).toEqual({ nodes: 4, edges: 2 });
    expect(store.deleteEdges([{ from: dec("D-004"), type: "GOVERNS", to: req("AUTH-01") }])).toBe(1);
    expect(store.counts().edges).toBe(1);
  });

  it("returns adjacency in deterministic (from, type, to) order with limit and truncation", () => {
    const store = openStore(location());
    seed(store);
    const login = sym("src/auth/AuthService.ts", "AuthService.login");
    const out = store.adjacentEdges([login], { direction: "outgoing", limit: 10 });
    expect(out.edges.map((e) => `${e.type} ${e.to}`)).toEqual([
      "CALLS sym:src/auth/AuthService.ts#AuthService.%23secret",
      "IMPLEMENTS req:AUTH-01",
    ]);
    const both = store.adjacentEdges([login], { direction: "both", limit: 10 });
    expect(both.edges).toHaveLength(3);
    const limited = store.adjacentEdges([login], { direction: "both", limit: 2 });
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.edges).toEqual(both.edges.slice(0, 2));
    expect(store.adjacentEdges([req("AUTH-01")], { direction: "incoming", types: ["GOVERNS"], limit: 10 }).edges.map((e) => e.from)).toEqual(["dec:D-004"]);
  });

  it("gives the same results regardless of insertion order", () => {
    const a = openStore(location());
    const b = openStore(location());
    seed(a);
    seed(b, [...NODES].reverse(), [...EDGES].reverse());
    const dump = (s: GraphStore) => ({
      nodes: s.listNodes({ limit: 100 }),
      edges: s.adjacentEdges(NODES.map((n) => n.ref), { direction: "both", limit: 100 }),
    });
    expect(dump(b)).toEqual(dump(a));
  });

  it("pages nodes by type with keyset pagination", () => {
    const store = openStore(location());
    seed(store);
    const first = store.listNodes({ type: "symbol", limit: 1 });
    const second = store.listNodes({ type: "symbol", limit: 1, afterId: first[0]?.id ?? "" });
    expect([...first, ...second].map((n) => n.id)).toEqual([
      "sym:src/auth/AuthService.ts#AuthService.%23secret",
      "sym:src/auth/AuthService.ts#AuthService.login",
    ]);
  });

  it("rejects invalid input", () => {
    const store = openStore(location());
    expect(code(() => store.upsertNodes([{ ref: req("AUTH-01"), payload: { n: Number.NaN } }]))).toBe("INVALID_INPUT");
    expect(code(() => store.upsertNodes([{ ref: req("AUTH-01"), payload: { f: (() => 1) as never } }]))).toBe("INVALID_INPUT");
    expect(code(() => store.upsertEdges([{ from: req("A-1"), type: "LIKES" as never, to: req("A-2") }]))).toBe("INVALID_INPUT");
    expect(code(() => store.adjacentEdges([req("A-1")], { direction: "outgoing", limit: 0 }))).toBe("INVALID_INPUT");
    expect(code(() => store.transaction(() => store.transaction(() => 1)))).toBe("NESTED_TRANSACTION");
    expect(code(() => store.transaction(async () => 1))).toBe("INVALID_INPUT");
    expect(store.counts().nodes).toBe(0);
  });

  it("refuses to work after close", () => {
    const store = openStore(location());
    store.close();
    expect(code(() => store.counts())).toBe("CLOSED");
  });
});

describe("NodeSqliteGraphStore file lifecycle", () => {
  it("persists data across reopen and uses WAL", () => {
    const f = tempFile();
    const first = openStore(f);
    seed(first);
    first.close();
    const second = openStore(f);
    expect(second.counts()).toEqual({ nodes: 5, edges: 5 });
    second.close();
    const raw = new DatabaseSync(f);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
  });

  it("AC-003-04 fails explicitly on another graph_schema_version and reports it as regenerable", () => {
    const f = tempFile();
    openStore(f).close();
    const raw = new DatabaseSync(f);
    raw.exec("UPDATE graph_meta SET value = '99' WHERE key = 'graph_schema_version'");
    raw.close();
    const r = openNodeSqliteGraphStore({ path: f });
    expect(r.value).toBeUndefined();
    expect(r.regenerable).toBe(true);
    expect(r.diagnostics.map((d) => [d.code, d.source?.path])).toEqual([["GRAPH_SCHEMA_UNSUPPORTED", f]]);
    expect(r.diagnostics[0]?.message).toContain("graph_schema_version 99");
  });

  it("AC-003-04 recreates the graph on request", () => {
    const f = tempFile();
    const s = openStore(f);
    seed(s);
    s.close();
    const raw = new DatabaseSync(f);
    raw.exec("UPDATE graph_meta SET value = '0' WHERE key = 'graph_schema_version'");
    raw.close();
    const r = openNodeSqliteGraphStore({ path: f, onUnsupportedSchema: "recreate" });
    if (r.value) open.push(r.value);
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["GRAPH_SCHEMA_UNSUPPORTED", "warning"]]);
    expect(r.value?.counts()).toEqual({ nodes: 0, edges: 0 });
  });

  it("does not claim a foreign SQLite database is regenerable", () => {
    const f = tempFile();
    const raw = new DatabaseSync(f);
    raw.exec("CREATE TABLE other (x INTEGER)");
    raw.close();
    const r = openNodeSqliteGraphStore({ path: f, onUnsupportedSchema: "recreate" });
    expect(r).toMatchObject({ regenerable: false, diagnostics: [{ code: "GRAPH_SCHEMA_UNSUPPORTED" }] });
    expect(fs.existsSync(f)).toBe(true);
  });

  it("reports a corrupt file without throwing and releases the file", () => {
    const f = tempFile();
    fs.writeFileSync(f, "not a database ".repeat(100));
    const r = openNodeSqliteGraphStore({ path: f });
    expect(r.value).toBeUndefined();
    expect(r).toMatchObject({ regenerable: false, diagnostics: [{ code: "GRAPH_OPEN_FAILED" }] });
    fs.rmSync(f); // throws EPERM on Windows if the handle were still open
  });

  it("AC-003-03 a second writer gets busy and still reads the last committed state", () => {
    const f = tempFile();
    const writer = openStore(f);
    const other = openStore(f, { busyTimeoutMs: 50 });
    seed(writer);
    writer.transaction((tx) => {
      tx.upsertNodes([{ ref: req("AUTH-02") }]);
      expect(other.tryTransaction(() => "never")).toEqual({ status: "busy" });
      expect(code(() => other.upsertNodes([{ ref: req("AUTH-03") }]))).toBe("BUSY");
      expect(other.getNode(req("AUTH-02"))).toBeUndefined(); // uncommitted write is not visible
      expect(other.counts().nodes).toBe(5);
    });
    expect(other.getNode(req("AUTH-02"))?.id).toBe("req:AUTH-02");
    expect(other.tryTransaction(() => "ok")).toEqual({ status: "committed", value: "ok" });
  });

  it("fails to open an empty database read-only instead of creating it", () => {
    expect(openNodeSqliteGraphStore({ path: tempFile(), readOnly: true }).diagnostics.map((d) => d.code)).toEqual(["GRAPH_OPEN_FAILED"]);
  });
});

describe("node IDs stored in the graph", () => {
  const cases = (JSON.parse(fs.readFileSync(new URL("../../../../../fixtures/core/node-ids.json", import.meta.url), "utf8")) as { cases: { ref: EntityRef }[] }).cases;

  it("stores and reads back every node-ids.json fixture entity", () => {
    const store = openStore(":memory:");
    store.upsertNodes(cases.map((c) => ({ ref: c.ref })));
    const ids = cases.map((c) => nodeId(c.ref)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const stored = store.listNodes({ limit: 100 });
    expect(stored.map((n) => n.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);
    for (const c of cases) expect(store.getNode(c.ref)?.ref).toEqual(c.ref);
  });
});
