/**
 * Graph scopes and canonical rows (TASK-008). Every node and edge belongs to exactly one scope,
 * decided by its endpoints alone: the file scope of the code node (File, or the owner file of a
 * Symbol/Test) at the source end, else at the target end, else the Project Truth scope. The Indexer
 * keeps one digest per scope and rewrites only scopes whose digest changed. Canonical rows are the
 * content that is compared: the same row text means the same stored node or edge.
 */
import { createHash } from "node:crypto";
import { nodeId, type EntityRef, type RepoPath, type SourceLocation } from "@duo-director/core";
import { canonicalJson } from "../store/json.js";
import type { GraphEdgeType, JsonObject } from "../store/types.js";

export const TRUTH_SCOPE = "truth";

/** The file a code node belongs to: a File itself, or the owner file of a Symbol or Test. */
export function codeFileOf(ref: EntityRef): RepoPath | undefined {
  return ref.type === "file" || ref.type === "symbol" || ref.type === "test" ? ref.path : undefined;
}

export function fileScope(path: RepoPath): string {
  return `file:${path}`;
}

export function nodeScope(ref: EntityRef): string {
  const file = codeFileOf(ref);
  return file === undefined ? TRUTH_SCOPE : fileScope(file);
}

export function edgeScope(from: EntityRef, to: EntityRef): string {
  const file = codeFileOf(from) ?? codeFileOf(to);
  return file === undefined ? TRUTH_SCOPE : fileScope(file);
}

interface NodeLike {
  readonly ref: EntityRef;
  readonly source?: SourceLocation | undefined;
  readonly contentHash?: string | undefined;
  readonly payload?: JsonObject | undefined;
  readonly ownerFile?: RepoPath | undefined;
}

interface EdgeLike {
  readonly from: EntityRef;
  readonly type: GraphEdgeType;
  readonly to: EntityRef;
  readonly metadata?: JsonObject | undefined;
}

const defined = (value: Record<string, unknown>): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as JsonObject;

/** Canonical text of a node as stored (id, owner, source, content hash, payload). */
export function nodeRow(node: NodeLike): string {
  const s = node.source;
  return canonicalJson(defined({
    id: nodeId(node.ref),
    ownerFile: node.ownerFile,
    source: s === undefined ? undefined : defined({ path: s.path, startLine: s.startLine, startColumn: s.startColumn, endLine: s.endLine, endColumn: s.endColumn }),
    contentHash: node.contentHash,
    payload: node.payload ?? {},
  }), "node");
}

/** Canonical text of an edge as stored (endpoints, type, metadata). */
export function edgeRow(edge: EdgeLike): string {
  return canonicalJson({ from: nodeId(edge.from), type: edge.type, to: nodeId(edge.to), metadata: edge.metadata ?? {} }, "edge");
}

/** sha256 digest per scope over the sorted canonical rows of the scope's nodes and edges. */
export function scopeDigests(nodes: readonly NodeLike[], edges: readonly EdgeLike[]): Map<string, string> {
  const rows = new Map<string, string[]>();
  const add = (scope: string, row: string) => {
    let list = rows.get(scope);
    if (list === undefined) rows.set(scope, (list = []));
    list.push(row);
  };
  for (const n of nodes) add(nodeScope(n.ref), `n${nodeRow(n)}`);
  for (const e of edges) add(edgeScope(e.from, e.to), `e${edgeRow(e)}`);
  const digests = new Map<string, string>();
  for (const [scope, list] of rows) {
    const hash = createHash("sha256");
    for (const row of list.sort()) hash.update(row).update("\n");
    digests.set(scope, `sha256:${hash.digest("hex")}`);
  }
  return digests;
}
