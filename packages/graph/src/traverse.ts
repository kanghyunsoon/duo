/**
 * Bounded, deterministic BFS over a GraphStore (AC-003-02). Uses only the adjacency primitive.
 * Order: depth, then node id. Weighted ranking for Context is the Context Compiler's job (TASK-010).
 */
import { parseNodeId, type EntityRef } from "@duo-director/core";
import { GraphStoreError, type EdgeDirection, type GraphEdge, type GraphEdgeType, type GraphNode, type GraphReader } from "./store/types.js";

export interface TraverseOptions {
  readonly maxDepth: number;
  readonly nodeLimit: number;
  readonly direction: EdgeDirection;
  readonly edgeTypes?: readonly GraphEdgeType[];
  /** Upper bound on edges read per depth level. Default 10 000. */
  readonly edgeLimitPerLevel?: number;
}

export interface TraversalResult {
  /** Visited nodes ordered by (depth, id). */
  readonly nodes: readonly { readonly node: GraphNode; readonly depth: number }[];
  /** Edges between visited nodes, ordered by (from, type, to). */
  readonly edges: readonly GraphEdge[];
  /** True when nodeLimit or edgeLimitPerLevel cut the traversal short. */
  readonly truncated: boolean;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function refOf(id: string): EntityRef {
  const ref = parseNodeId(id);
  if (ref === undefined) throw new GraphStoreError("INTERNAL", `Corrupt node id: ${id}`);
  return ref;
}

export function traverse(store: GraphReader, seeds: readonly EntityRef[], options: TraverseOptions): TraversalResult {
  const { maxDepth, nodeLimit } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new GraphStoreError("INVALID_INPUT", `maxDepth must be a non-negative integer`);
  if (!Number.isInteger(nodeLimit) || nodeLimit < 1) throw new GraphStoreError("INVALID_INPUT", `nodeLimit must be a positive integer`);
  const edgeLimit = options.edgeLimitPerLevel ?? 10_000;

  let truncated = false;
  const depthOf = new Map<string, number>();
  const seedNodes = store.getNodes(seeds);
  for (const node of seedNodes) {
    if (depthOf.size >= nodeLimit) { truncated = true; break; }
    depthOf.set(node.id, 0);
  }
  const edges = new Map<string, GraphEdge>();
  let frontier = [...depthOf.keys()];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const result = store.adjacentEdges(frontier.map(refOf), {
      direction: options.direction,
      limit: edgeLimit,
      ...(options.edgeTypes === undefined ? {} : { types: options.edgeTypes }),
    });
    if (result.truncated) truncated = true;
    const inFrontier = new Set(frontier);
    const candidates = new Set<string>();
    for (const edge of result.edges) {
      edges.set(`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge);
      if (options.direction !== "incoming" && inFrontier.has(edge.from) && !depthOf.has(edge.to)) candidates.add(edge.to);
      if (options.direction !== "outgoing" && inFrontier.has(edge.to) && !depthOf.has(edge.from)) candidates.add(edge.from);
    }
    const next: string[] = [];
    for (const id of [...candidates].sort(byId)) {
      if (depthOf.size >= nodeLimit) { truncated = true; break; }
      depthOf.set(id, depth);
      next.push(id);
    }
    frontier = next;
  }

  const nodes = store.getNodes([...depthOf.keys()].map(refOf))
    .map((node) => ({ node, depth: depthOf.get(node.id) ?? 0 }))
    .sort((a, b) => a.depth - b.depth || byId(a.node.id, b.node.id));
  const kept = [...edges.values()]
    .filter((e) => depthOf.has(e.from) && depthOf.has(e.to))
    .sort((a, b) => byId(a.from, b.from) || byId(a.type, b.type) || byId(a.to, b.to));
  return { nodes, edges: kept, truncated };
}
