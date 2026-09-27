/**
 * NodeSqliteGraphStore: the only module that imports node:sqlite (ADR-002, enforced by lint).
 * Synchronous, one connection per store. File databases use WAL so readers see the last committed
 * state while another connection writes.
 */
import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createDiagnostic, nodeId, parseNodeId, withSeverity, type Diagnostic, type EntityRef, type EntityType, type SourceLocation } from "@duo-director/core";
import { canonicalJson } from "../json.js";
import {
  GRAPH_EDGE_TYPES, GraphStoreError,
  type AdjacencyQuery, type AdjacencyResult, type EdgeKey, type GraphEdge, type GraphEdgeInput, type GraphEdgeType,
  type GraphNode, type GraphNodeInput, type GraphOpenResult, type GraphReader, type GraphStore, type GraphWriter,
  type JsonObject, type NodeQuery, type TryTransactionResult,
} from "../types.js";
import { GRAPH_SCHEMA_VERSION, SCHEMA_SQL } from "./schema.js";

export interface OpenNodeSqliteGraphStoreOptions {
  /** File path, or ":memory:". */
  readonly path: string;
  readonly readOnly?: boolean;
  /** How long a writer waits for the lock before BUSY. Default 5000 ms. */
  readonly busyTimeoutMs?: number;
  /**
   * What to do with a DUO graph database of another graph_schema_version.
   * "fail" (default) returns GRAPH_SCHEMA_UNSUPPORTED with regenerable: true.
   * "recreate" deletes the database files and creates an empty graph.
   */
  readonly onUnsupportedSchema?: "fail" | "recreate";
}

const SQLITE_BUSY = 5;
const SQLITE_READONLY = 8;
const SQLITE_CONSTRAINT = 19;

interface SqliteError extends Error { errcode?: number }

function sqliteCode(error: unknown): number | undefined {
  const code = (error as SqliteError | undefined)?.errcode;
  return typeof code === "number" ? code & 0xff : undefined;
}

function toStoreError(error: unknown): unknown {
  if (error instanceof GraphStoreError) return error;
  const code = sqliteCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === SQLITE_BUSY) return new GraphStoreError("BUSY", `Graph database is locked by another writer: ${message}`, { cause: error });
  if (code === SQLITE_CONSTRAINT) return new GraphStoreError("CONSTRAINT", `Graph constraint failed: ${message}`, { cause: error });
  if (code === SQLITE_READONLY) return new GraphStoreError("READ_ONLY", `Graph database is read-only: ${message}`, { cause: error });
  return error;
}

interface NodeRow {
  id: string; type: string; source_path: string | null;
  source_start_line: number | null; source_start_column: number | null; source_end_line: number | null; source_end_column: number | null;
  content_hash: string | null; payload: string;
}
interface EdgeRow { from_id: string; type: string; to_id: string; metadata: string }

const NODE_COLUMNS = "id, type, source_path, source_start_line, source_start_column, source_end_line, source_end_column, content_hash, payload";

function toNode(row: NodeRow): GraphNode {
  const ref = parseNodeId(row.id);
  if (ref === undefined || ref.type !== row.type) throw new GraphStoreError("INTERNAL", `Corrupt node id in graph database: ${row.id}`);
  let source: SourceLocation | undefined;
  if (row.source_path !== null) {
    const s: { -readonly [K in keyof SourceLocation]: SourceLocation[K] } = { path: row.source_path };
    if (row.source_start_line !== null) s.startLine = row.source_start_line;
    if (row.source_start_column !== null) s.startColumn = row.source_start_column;
    if (row.source_end_line !== null) s.endLine = row.source_end_line;
    if (row.source_end_column !== null) s.endColumn = row.source_end_column;
    source = s;
  }
  return { id: row.id, type: ref.type, ref, source, contentHash: row.content_hash ?? undefined, payload: JSON.parse(row.payload) as JsonObject };
}

function toEdge(row: EdgeRow): GraphEdge {
  return { from: row.from_id, type: row.type as GraphEdgeType, to: row.to_id, metadata: JSON.parse(row.metadata) as JsonObject };
}

function checkEdgeType(type: string): void {
  if (!(GRAPH_EDGE_TYPES as readonly string[]).includes(type)) throw new GraphStoreError("INVALID_INPUT", `Unknown edge type "${type}"`);
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new GraphStoreError("INVALID_INPUT", `limit must be a positive integer, got ${limit}`);
}

class NodeSqliteGraphStore implements GraphStore {
  readonly graphSchemaVersion = GRAPH_SCHEMA_VERSION;
  private closed = false;
  private inTransaction = false;
  private readonly stmt: Record<string, StatementSync>;
  private readonly view: GraphReader & GraphWriter;

  constructor(private readonly db: DatabaseSync) {
    const p = (sql: string) => db.prepare(sql);
    this.stmt = {
      upsertNode: p(`INSERT INTO graph_nodes (${NODE_COLUMNS}) VALUES ($id, $type, $source_path, $source_start_line, $source_start_column, $source_end_line, $source_end_column, $content_hash, $payload)
        ON CONFLICT (id) DO UPDATE SET type = excluded.type, source_path = excluded.source_path, source_start_line = excluded.source_start_line,
        source_start_column = excluded.source_start_column, source_end_line = excluded.source_end_line, source_end_column = excluded.source_end_column,
        content_hash = excluded.content_hash, payload = excluded.payload`),
      upsertEdge: p(`INSERT INTO graph_edges (from_id, type, to_id, metadata) VALUES ($from, $type, $to, $metadata)
        ON CONFLICT (from_id, type, to_id) DO UPDATE SET metadata = excluded.metadata`),
      getNodes: p(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE id IN (SELECT value FROM json_each($ids)) ORDER BY id`),
      listAll: p(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE id > $after ORDER BY id LIMIT $limit`),
      listByType: p(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE type = $type AND id > $after ORDER BY id LIMIT $limit`),
      outgoing: p(`SELECT from_id, type, to_id, metadata FROM graph_edges
        WHERE from_id IN (SELECT value FROM json_each($ids)) AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
        ORDER BY from_id, type, to_id LIMIT $limit`),
      incoming: p(`SELECT from_id, type, to_id, metadata FROM graph_edges
        WHERE to_id IN (SELECT value FROM json_each($ids)) AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
        ORDER BY from_id, type, to_id LIMIT $limit`),
      both: p(`SELECT from_id, type, to_id, metadata FROM (
          SELECT * FROM graph_edges WHERE from_id IN (SELECT value FROM json_each($ids))
          UNION SELECT * FROM graph_edges WHERE to_id IN (SELECT value FROM json_each($ids))
        ) WHERE ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
        ORDER BY from_id, type, to_id LIMIT $limit`),
      deleteNodes: p(`DELETE FROM graph_nodes WHERE id IN (SELECT value FROM json_each($ids))`),
      deleteEdge: p(`DELETE FROM graph_edges WHERE from_id = $from AND type = $type AND to_id = $to`),
      countNodes: p(`SELECT count(*) AS n FROM graph_nodes`),
      countEdges: p(`SELECT count(*) AS n FROM graph_edges`),
    };
    const reader: GraphReader = {
      getNode: (ref) => this.getNodes([ref])[0],
      getNodes: (refs) => this.getNodes(refs),
      listNodes: (q) => this.listNodes(q),
      adjacentEdges: (refs, q) => this.adjacentEdges(refs, q),
      counts: () => this.counts(),
    };
    const writer: GraphWriter = {
      upsertNodes: (nodes) => this.write(() => this.doUpsertNodes(nodes)),
      upsertEdges: (edges) => this.write(() => this.doUpsertEdges(edges)),
      deleteNodes: (refs) => this.write(() => this.doDeleteNodes(refs)),
      deleteEdges: (keys) => this.write(() => this.doDeleteEdges(keys)),
    };
    this.view = { ...reader, ...writer };
  }

  private open(): void {
    if (this.closed) throw new GraphStoreError("CLOSED", "Graph store is closed");
  }

  private run<T>(fn: () => T): T {
    this.open();
    try {
      return fn();
    } catch (error) {
      throw toStoreError(error);
    }
  }

  /** Writes run inside the current transaction, or in their own. */
  private write<T>(fn: () => T): T {
    return this.inTransaction ? this.run(fn) : this.transaction(() => fn());
  }

  transaction<T>(fn: (tx: GraphReader & GraphWriter) => T): T {
    const result = this.tryTransaction(fn);
    if (result.status === "busy") throw new GraphStoreError("BUSY", "Graph database is locked by another writer");
    return result.value;
  }

  tryTransaction<T>(fn: (tx: GraphReader & GraphWriter) => T): TryTransactionResult<T> {
    this.open();
    if (this.inTransaction) throw new GraphStoreError("NESTED_TRANSACTION", "Graph transactions are not reentrant");
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (sqliteCode(error) === SQLITE_BUSY) return { status: "busy" };
      throw toStoreError(error);
    }
    this.inTransaction = true;
    try {
      const value = fn(this.view);
      if (typeof (value as { then?: unknown } | null)?.then === "function") {
        throw new GraphStoreError("INVALID_INPUT", "Graph transaction callbacks must be synchronous");
      }
      this.db.exec("COMMIT");
      return { status: "committed", value };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw toStoreError(error);
    } finally {
      this.inTransaction = false;
    }
  }

  private doUpsertNodes(nodes: readonly GraphNodeInput[]): void {
    for (const node of nodes) {
      const id = nodeId(node.ref);
      const s = node.source;
      this.stmt.upsertNode!.run({
        id, type: node.ref.type,
        source_path: s?.path ?? null,
        source_start_line: s?.startLine ?? null,
        source_start_column: s?.startColumn ?? null,
        source_end_line: s?.endLine ?? null,
        source_end_column: s?.endColumn ?? null,
        content_hash: node.contentHash ?? null,
        payload: canonicalJson(node.payload, `${id}.payload`),
      });
    }
  }

  private doUpsertEdges(edges: readonly GraphEdgeInput[]): void {
    for (const edge of edges) {
      checkEdgeType(edge.type);
      const from = nodeId(edge.from);
      const to = nodeId(edge.to);
      this.stmt.upsertEdge!.run({ from, type: edge.type, to, metadata: canonicalJson(edge.metadata, `${from} ${edge.type} ${to}.metadata`) });
    }
  }

  private doDeleteNodes(refs: readonly EntityRef[]): number {
    return Number(this.stmt.deleteNodes!.run({ ids: JSON.stringify(refs.map(nodeId)) }).changes);
  }

  private doDeleteEdges(keys: readonly EdgeKey[]): number {
    let n = 0;
    for (const k of keys) n += Number(this.stmt.deleteEdge!.run({ from: nodeId(k.from), type: k.type, to: nodeId(k.to) }).changes);
    return n;
  }

  getNode(ref: EntityRef): GraphNode | undefined {
    return this.getNodes([ref])[0];
  }

  getNodes(refs: readonly EntityRef[]): GraphNode[] {
    return this.run(() => (this.stmt.getNodes!.all({ ids: JSON.stringify(refs.map(nodeId)) }) as unknown as NodeRow[]).map(toNode));
  }

  listNodes(query: NodeQuery): GraphNode[] {
    checkLimit(query.limit);
    return this.run(() => {
      const params = { after: query.afterId ?? "", limit: query.limit };
      const rows = query.type === undefined
        ? this.stmt.listAll!.all(params)
        : this.stmt.listByType!.all({ ...params, type: query.type satisfies EntityType });
      return (rows as unknown as NodeRow[]).map(toNode);
    });
  }

  adjacentEdges(refs: readonly EntityRef[], query: AdjacencyQuery): AdjacencyResult {
    checkLimit(query.limit);
    query.types?.forEach(checkEdgeType);
    if (refs.length === 0 || query.types?.length === 0) return { edges: [], truncated: false };
    return this.run(() => {
      const rows = this.stmt[query.direction]!.all({
        ids: JSON.stringify(refs.map(nodeId)),
        types: query.types === undefined ? null : JSON.stringify(query.types),
        limit: query.limit + 1,
      }) as unknown as EdgeRow[];
      return { edges: rows.slice(0, query.limit).map(toEdge), truncated: rows.length > query.limit };
    });
  }

  counts(): { nodes: number; edges: number } {
    return this.run(() => ({
      nodes: Number((this.stmt.countNodes!.get() as { n: number }).n),
      edges: Number((this.stmt.countEdges!.get() as { n: number }).n),
    }));
  }

  upsertNodes(nodes: readonly GraphNodeInput[]): void { this.view.upsertNodes(nodes); }
  upsertEdges(edges: readonly GraphEdgeInput[]): void { this.view.upsertEdges(edges); }
  deleteNodes(refs: readonly EntityRef[]): number { return this.view.deleteNodes(refs); }
  deleteEdges(keys: readonly EdgeKey[]): number { return this.view.deleteEdges(keys); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

type SchemaState = { kind: "empty" } | { kind: "ok" } | { kind: "unsupported"; found: string; duoGraph: boolean };

function inspectSchema(db: DatabaseSync): SchemaState {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map((t) => t.name);
  if (tables.length === 0) return { kind: "empty" };
  if (!tables.includes("graph_meta")) return { kind: "unsupported", found: "none (not a DUO graph database)", duoGraph: false };
  const row = db.prepare("SELECT value FROM graph_meta WHERE key = 'graph_schema_version'").get() as { value: string } | undefined;
  if (row === undefined) return { kind: "unsupported", found: "missing", duoGraph: true };
  return row.value === String(GRAPH_SCHEMA_VERSION) ? { kind: "ok" } : { kind: "unsupported", found: row.value, duoGraph: true };
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(path + suffix, { force: true });
}

/** Opens (and if empty, creates) a graph database. Never throws for a bad or foreign database file. */
export function openNodeSqliteGraphStore(options: OpenNodeSqliteGraphStoreOptions): GraphOpenResult {
  const source: SourceLocation = { path: options.path };
  const fail = (diagnostic: Diagnostic, regenerable = false): GraphOpenResult => ({ diagnostics: [diagnostic], regenerable });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(options.path, { readOnly: options.readOnly ?? false, enableForeignKeyConstraints: true });
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA foreign_keys = ON");
    if (options.path !== ":memory:" && !options.readOnly) db.prepare("PRAGMA journal_mode = WAL").get();
    let state = inspectSchema(db);
    if (state.kind === "unsupported") {
      const diagnostic = createDiagnostic(
        "GRAPH_SCHEMA_UNSUPPORTED",
        `graph_schema_version ${state.found} is not supported (expected ${GRAPH_SCHEMA_VERSION})${state.duoGraph ? "; the graph database is generated data and can be rebuilt" : ""}`,
        source,
      );
      if (!state.duoGraph || options.onUnsupportedSchema !== "recreate" || options.path === ":memory:" || options.readOnly) {
        db.close();
        return fail(diagnostic, state.duoGraph);
      }
      db.close();
      removeDatabaseFiles(options.path);
      const reopened = openNodeSqliteGraphStore({ ...options, onUnsupportedSchema: "fail" });
      return { ...reopened, diagnostics: [withSeverity(diagnostic, "warning"), ...reopened.diagnostics] };
    }
    if (state.kind === "empty") {
      if (options.readOnly) {
        db.close();
        return fail(createDiagnostic("GRAPH_OPEN_FAILED", "Graph database is empty and was opened read-only", source));
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        state = inspectSchema(db); // another process may have created it meanwhile
        if (state.kind === "empty") {
          db.exec(SCHEMA_SQL);
          db.prepare("INSERT INTO graph_meta (key, value) VALUES ('graph_schema_version', $v)").run({ v: String(GRAPH_SCHEMA_VERSION) });
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
      if (state.kind === "unsupported") {
        db.close();
        return fail(createDiagnostic("GRAPH_SCHEMA_UNSUPPORTED", `graph_schema_version ${state.found} is not supported`, source), state.duoGraph);
      }
    }
    return { value: new NodeSqliteGraphStore(db), diagnostics: [], regenerable: false };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already closed
    }
    return fail(createDiagnostic("GRAPH_OPEN_FAILED", `Cannot open graph database: ${error instanceof Error ? error.message : String(error)}`, source));
  }
}
