/**
 * Plan-to-graph diff for the scopes that changed (TASK-008). Reads the stored rows of each changed
 * scope, compares canonical rows with the new plan and returns what to add, update and delete. The
 * business-level comparison stays here; GraphStore only stores. Unchanged scopes are not read.
 */
import { compareUtf8, fileRef, nodeId, parseNodeId, type EntityRef, type EntityType, type RepoPath } from "@duo-director/core";
import { edgeRow, edgeScope, nodeRow, nodeScope, TRUTH_SCOPE } from "../build/scope.js";
import { GraphStoreError, type EdgeKey, type GraphEdgeInput, type GraphNode, type GraphNodeInput, type GraphReader, type GraphWriter } from "../store/types.js";

export interface GraphDiff {
  readonly nodesToUpsert: readonly GraphNodeInput[];
  readonly nodesToDelete: readonly EntityRef[];
  readonly edgesToUpsert: readonly GraphEdgeInput[];
  readonly edgesToDelete: readonly EdgeKey[];
  readonly nodesAdded: number;
  readonly nodesUpdated: number;
  readonly edgesAdded: number;
  readonly edgesUpdated: number;
}

const PAGE = 1000;
const REF_CHUNK = 400;
const TRUTH_TYPES: readonly EntityType[] = ["project", "milestone", "requirement", "decision", "issue"];

function refOf(id: string): EntityRef {
  const ref = parseNodeId(id);
  if (ref === undefined) throw new GraphStoreError("INTERNAL", `Corrupt node id: ${id}`);
  return ref;
}

function listAll(store: GraphReader, query: { type?: EntityType; ownerFile?: RepoPath }): GraphNode[] {
  const out: GraphNode[] = [];
  for (let page = store.listNodes({ ...query, limit: PAGE }); page.length > 0; page = store.listNodes({ ...query, afterId: page.at(-1)?.id ?? "", limit: PAGE })) {
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/** Stored nodes and edges of one scope. */
function readScope(store: GraphReader, scope: string): { nodes: GraphNode[]; edges: GraphEdgeInput[] } {
  let nodes: GraphNode[];
  if (scope === TRUTH_SCOPE) nodes = TRUTH_TYPES.flatMap((type) => listAll(store, { type }));
  else {
    const path = scope.slice("file:".length) as RepoPath;
    nodes = [...store.getNodes([fileRef(path)]), ...listAll(store, { ownerFile: path })];
  }
  const edges = new Map<string, GraphEdgeInput>();
  for (let i = 0; i < nodes.length; i += REF_CHUNK) {
    const refs = nodes.slice(i, i + REF_CHUNK).map((n) => n.ref);
    const r = store.adjacentEdges(refs, { direction: scope === TRUTH_SCOPE ? "outgoing" : "both", limit: 1_000_000 });
    if (r.truncated) throw new GraphStoreError("INTERNAL", `Too many edges in scope ${scope}`);
    for (const e of r.edges) {
      const from = refOf(e.from);
      const to = refOf(e.to);
      if (edgeScope(from, to) === scope) edges.set(`${e.from}\u0000${e.type}\u0000${e.to}`, { from, type: e.type, to, metadata: e.metadata });
    }
  }
  return { nodes, edges: [...edges.values()] };
}

export function diffScopes(store: GraphReader, scopes: ReadonlySet<string>, plan: { readonly nodes: readonly GraphNodeInput[]; readonly edges: readonly GraphEdgeInput[] }): GraphDiff {
  const wantedNodes = new Map<string, GraphNodeInput>();
  for (const n of plan.nodes) if (scopes.has(nodeScope(n.ref))) wantedNodes.set(nodeId(n.ref), n);
  const wantedEdges = new Map<string, GraphEdgeInput>();
  for (const e of plan.edges) if (scopes.has(edgeScope(e.from, e.to))) wantedEdges.set(`${nodeId(e.from)}\u0000${e.type}\u0000${nodeId(e.to)}`, e);

  const storedNodes = new Map<string, string>();
  const storedNodeRefs = new Map<string, EntityRef>();
  const storedEdges = new Map<string, { row: string; key: EdgeKey }>();
  for (const scope of [...scopes].sort(compareUtf8)) {
    const { nodes, edges } = readScope(store, scope);
    for (const n of nodes) {
      storedNodes.set(n.id, nodeRow(n));
      storedNodeRefs.set(n.id, n.ref);
    }
    for (const e of edges) storedEdges.set(`${nodeId(e.from)}\u0000${e.type}\u0000${nodeId(e.to)}`, { row: edgeRow(e), key: { from: e.from, type: e.type, to: e.to } });
  }

  const nodesToUpsert: GraphNodeInput[] = [];
  let nodesAdded = 0;
  for (const [id, n] of [...wantedNodes].sort(([a], [b]) => compareUtf8(a, b))) {
    const stored = storedNodes.get(id);
    if (stored === undefined) nodesAdded++;
    if (stored !== nodeRow(n)) nodesToUpsert.push(n);
  }
  const nodesToDelete = [...storedNodeRefs].filter(([id]) => !wantedNodes.has(id)).sort(([a], [b]) => compareUtf8(a, b)).map(([, ref]) => ref);
  const edgesToUpsert: GraphEdgeInput[] = [];
  let edgesAdded = 0;
  for (const [key, e] of [...wantedEdges].sort(([a], [b]) => compareUtf8(a, b))) {
    const stored = storedEdges.get(key);
    if (stored === undefined) edgesAdded++;
    if (stored?.row !== edgeRow(e)) edgesToUpsert.push(e);
  }
  const edgesToDelete = [...storedEdges].filter(([key]) => !wantedEdges.has(key)).sort(([a], [b]) => compareUtf8(a, b)).map(([, v]) => v.key);
  return {
    nodesToUpsert, nodesToDelete, edgesToUpsert, edgesToDelete,
    nodesAdded, nodesUpdated: nodesToUpsert.length - nodesAdded, edgesAdded, edgesUpdated: edgesToUpsert.length - edgesAdded,
  };
}

/** Applies a diff inside the caller's transaction. Deleting a node also deletes its edges. */
export function applyGraphDiff(tx: GraphWriter, diff: GraphDiff): void {
  tx.deleteEdges(diff.edgesToDelete);
  tx.deleteNodes(diff.nodesToDelete);
  tx.upsertNodes(diff.nodesToUpsert);
  tx.upsertEdges(diff.edgesToUpsert);
}
