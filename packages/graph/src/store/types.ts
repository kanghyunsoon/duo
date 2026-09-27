/**
 * GraphStore contract. Storage-agnostic: no SQL, no SQLite types. Nodes and edges are addressed
 * with core EntityRefs; node IDs come only from core nodeId() (ADR-002, TASK-003).
 */
import type { EntityRef, EntityType, ParseResult, RepoPath, SourceLocation } from "@duo-director/core";

/** Edge types (docs/04-project-graph.md). SUPERSEDES was added in T02.1 (H-20). */
export const GRAPH_EDGE_TYPES = [
  "CONTAINS", "REQUIRES", "IMPLEMENTS", "CALLS", "IMPORTS", "GOVERNS", "TRACKED_BY", "VALIDATED_BY", "CHANGED_WITH", "SUPERSEDES",
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface GraphNodeInput {
  readonly ref: EntityRef;
  readonly source?: SourceLocation | undefined;
  readonly contentHash?: string | undefined;
  /** Reference metadata. Stored as canonical JSON (sorted keys). */
  readonly payload?: JsonObject | undefined;
  /**
   * File a derived node belongs to (Symbol, Test: TASK-008). Incremental indexing deletes and
   * rebuilds a file's derived nodes by this key. Project Truth and File nodes have none.
   */
  readonly ownerFile?: RepoPath | undefined;
}

export interface GraphNode {
  /** core nodeId(ref). */
  readonly id: string;
  readonly type: EntityType;
  readonly ref: EntityRef;
  readonly source: SourceLocation | undefined;
  readonly contentHash: string | undefined;
  readonly payload: JsonObject;
  readonly ownerFile: RepoPath | undefined;
}

export interface GraphEdgeInput {
  readonly from: EntityRef;
  readonly type: GraphEdgeType;
  readonly to: EntityRef;
  readonly metadata?: JsonObject | undefined;
}

export interface GraphEdge {
  /** Node ID of the source. */
  readonly from: string;
  readonly type: GraphEdgeType;
  /** Node ID of the target. */
  readonly to: string;
  readonly metadata: JsonObject;
}

export interface EdgeKey {
  readonly from: EntityRef;
  readonly type: GraphEdgeType;
  readonly to: EntityRef;
}

export type EdgeDirection = "outgoing" | "incoming" | "both";

export interface NodeQuery {
  readonly type?: EntityType;
  /** Only nodes owned by this file (GraphNodeInput.ownerFile). */
  readonly ownerFile?: RepoPath;
  /** Keyset pagination: return nodes with id greater than this. */
  readonly afterId?: string;
  readonly limit: number;
}

export interface AdjacencyQuery {
  readonly direction: EdgeDirection;
  readonly types?: readonly GraphEdgeType[];
  /** Maximum number of edges to return. */
  readonly limit: number;
}

export interface AdjacencyResult {
  /** Ordered by (from, type, to). */
  readonly edges: readonly GraphEdge[];
  /** True when more edges matched than the limit. */
  readonly truncated: boolean;
}

export interface GraphReader {
  getNode(ref: EntityRef): GraphNode | undefined;
  /** Existing nodes among refs, ordered by id. */
  getNodes(refs: readonly EntityRef[]): GraphNode[];
  /** Nodes ordered by id. */
  listNodes(query: NodeQuery): GraphNode[];
  /** Bounded lookup primitive: edges touching any of refs, deterministic order. */
  adjacentEdges(refs: readonly EntityRef[], query: AdjacencyQuery): AdjacencyResult;
  counts(): { readonly nodes: number; readonly edges: number };
  /** A graph metadata value (e.g. "graph_revision"), or undefined. */
  readMeta(key: string): string | undefined;
}

export interface GraphWriter {
  /** Insert or replace nodes by id. */
  upsertNodes(nodes: readonly GraphNodeInput[]): void;
  /** Insert edges; an existing (from, type, to) keeps one row and takes the new metadata. Idempotent. */
  upsertEdges(edges: readonly GraphEdgeInput[]): void;
  /** Deletes nodes and every edge that touches them. Returns the number of deleted nodes. */
  deleteNodes(refs: readonly EntityRef[]): number;
  deleteEdges(keys: readonly EdgeKey[]): number;
  /** Sets a graph metadata value. "graph_schema_version" is reserved and cannot be written. */
  writeMeta(key: string, value: string): void;
}

export type TryTransactionResult<T> = { readonly status: "committed"; readonly value: T } | { readonly status: "busy" };

export interface GraphStore extends GraphReader, GraphWriter {
  /** Graph DB schema version (not the Project Truth schema_version). */
  readonly graphSchemaVersion: number;
  /**
   * Runs fn in one write transaction. Commits when fn returns, rolls back when it throws.
   * Referential integrity is checked at commit, so nodes and edges may be written in any order.
   * Writes outside a transaction run in their own transaction. Not reentrant; fn must be synchronous.
   */
  transaction<T>(fn: (tx: GraphReader & GraphWriter) => T): T;
  /** Like transaction(), but returns { status: "busy" } when another writer holds the lock. */
  tryTransaction<T>(fn: (tx: GraphReader & GraphWriter) => T): TryTransactionResult<T>;
  close(): void;
}

export type GraphStoreErrorCode = "BUSY" | "CONSTRAINT" | "CLOSED" | "READ_ONLY" | "INVALID_INPUT" | "NESTED_TRANSACTION" | "INTERNAL";

export class GraphStoreError extends Error {
  constructor(readonly code: GraphStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphStoreError";
  }
}

export interface GraphOpenResult extends ParseResult<GraphStore> {
  /**
   * True when the file is a DUO graph database with an unsupported graph_schema_version:
   * it is generated data and can be deleted and rebuilt.
   */
  readonly regenerable: boolean;
}
