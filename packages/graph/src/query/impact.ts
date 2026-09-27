/**
 * Impact primitive (TASK-008, 04 탐색): what the DUO Graph shows as affected by a change to files or
 * symbols. It is graph evidence, not a complete static analysis: CALLS holds exact resolutions only
 * (instance-receiver calls stay unresolved, C53), so code the Graph cannot link is not reported.
 *
 * Each reached node gets the weakest relation on its best path:
 *   direct      reverse CALLS (callers), reverse IMPORTS (importers), VALIDATED_BY (tests and the
 *               Requirements they validate), IMPLEMENTS (Requirements), GOVERNS (Decisions);
 *   structural  CONTAINS (a changed file's symbols, a symbol's class and file);
 *   historical  CHANGED_WITH (co-change correlation, not a dependency).
 * Nodes are ranked by (relation, depth, id). No scores.
 */
import { compareUtf8, fileRef, parseNodeId, type EntityRef, type EntityType, type RepoPath } from "@duo-director/core";
import { GraphStoreError, type EdgeDirection, type GraphEdgeType, type GraphReader } from "../store/types.js";

export type ImpactRelation = "direct" | "structural" | "historical";

export interface ImpactItem {
  readonly id: string;
  readonly ref: EntityRef;
  readonly depth: number;
  readonly relation: ImpactRelation;
  /** The edge that reached the node on its best path. */
  readonly via: { readonly from: string; readonly edge: GraphEdgeType; readonly direction: "outgoing" | "incoming" };
}

export interface ImpactResult {
  /** Seeds that exist in the graph. */
  readonly seeds: readonly string[];
  /** Reached nodes (seeds excluded) in (relation, depth, id) order. */
  readonly items: readonly ImpactItem[];
  readonly truncated: boolean;
  /** What the result claims: relations recorded in the DUO Graph, not every affected line of code. */
  readonly evidence: "graph";
}

export interface ImpactOptions {
  /** Default 2 (04). */
  readonly maxDepth?: number;
  /** Reached nodes kept, seeds excluded. Default 200. */
  readonly nodeLimit?: number;
}

const RANK: Readonly<Record<ImpactRelation, number>> = { direct: 0, structural: 1, historical: 2 };

interface Step { readonly edge: GraphEdgeType; readonly direction: Exclude<EdgeDirection, "both">; readonly relation: ImpactRelation; readonly seedOnly?: boolean }

/** Which relations are followed from each node type. Project Truth nodes end a path. */
const STEPS: Readonly<Partial<Record<EntityType, readonly Step[]>>> = {
  symbol: [
    { edge: "CALLS", direction: "incoming", relation: "direct" },
    { edge: "VALIDATED_BY", direction: "outgoing", relation: "direct" },
    { edge: "IMPLEMENTS", direction: "outgoing", relation: "direct" },
    { edge: "GOVERNS", direction: "incoming", relation: "direct" },
    { edge: "CONTAINS", direction: "incoming", relation: "structural" },
  ],
  file: [
    { edge: "IMPORTS", direction: "incoming", relation: "direct" },
    { edge: "IMPLEMENTS", direction: "outgoing", relation: "direct" },
    { edge: "GOVERNS", direction: "incoming", relation: "direct" },
    { edge: "CONTAINS", direction: "outgoing", relation: "structural", seedOnly: true },
    { edge: "CHANGED_WITH", direction: "outgoing", relation: "historical" },
  ],
  test: [{ edge: "VALIDATED_BY", direction: "incoming", relation: "direct" }],
};

function refOf(id: string): EntityRef {
  const ref = parseNodeId(id);
  if (ref === undefined) throw new GraphStoreError("INTERNAL", `Corrupt node id: ${id}`);
  return ref;
}

export function impact(store: GraphReader, seeds: readonly EntityRef[], options: ImpactOptions = {}): ImpactResult {
  const maxDepth = options.maxDepth ?? 2;
  const nodeLimit = options.nodeLimit ?? 200;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new GraphStoreError("INVALID_INPUT", "maxDepth must be a non-negative integer");
  if (!Number.isInteger(nodeLimit) || nodeLimit < 1) throw new GraphStoreError("INVALID_INPUT", "nodeLimit must be a positive integer");
  const seedIds = store.getNodes(seeds).map((n) => n.id).sort(compareUtf8);
  const seedSet = new Set(seedIds);
  const best = new Map<string, ImpactItem>();
  const better = (a: { relation: ImpactRelation; depth: number }, b: { relation: ImpactRelation; depth: number }) =>
    RANK[a.relation] - RANK[b.relation] || a.depth - b.depth;
  // Frontier entries: (node, relation of the path so far, depth), processed in (relation, depth, id) order.
  // A node is expanded again only for a path no earlier expansion dominates (weaker-or-equal relation
  // and deeper-or-equal depth), so the depth bound never hides a node another path class would reach.
  const queue: { id: string; relation: ImpactRelation; depth: number }[] = seedIds.map((id) => ({ id, relation: "direct" as const, depth: 0 }));
  const expanded = new Map<string, { relation: ImpactRelation; depth: number }[]>();
  const dominated = (id: string, relation: ImpactRelation, depth: number) =>
    (expanded.get(id) ?? []).some((e) => RANK[e.relation] <= RANK[relation] && e.depth <= depth);
  let truncated = false;
  while (queue.length > 0) {
    queue.sort((a, b) => better(a, b) || compareUtf8(a.id, b.id));
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth >= maxDepth || dominated(current.id, current.relation, current.depth)) continue;
    expanded.set(current.id, [...(expanded.get(current.id) ?? []), { relation: current.relation, depth: current.depth }]);
    const ref = refOf(current.id);
    for (const step of STEPS[ref.type] ?? []) {
      if (step.seedOnly === true && current.depth !== 0) continue;
      const r = store.adjacentEdges([ref], { direction: step.direction, types: [step.edge], limit: nodeLimit + 1 });
      if (r.truncated) truncated = true;
      for (const e of r.edges) {
        const other = step.direction === "incoming" ? e.from : e.to;
        if (seedSet.has(other)) continue;
        const relation = RANK[step.relation] > RANK[current.relation] ? step.relation : current.relation;
        const item: ImpactItem = { id: other, ref: refOf(other), depth: current.depth + 1, relation, via: { from: current.id, edge: step.edge, direction: step.direction } };
        const known = best.get(other);
        if (known === undefined && best.size >= nodeLimit) {
          truncated = true;
          continue;
        }
        if (known === undefined || better(item, known) < 0) best.set(other, item);
        if (!dominated(other, relation, item.depth)) queue.push({ id: other, relation, depth: item.depth });
      }
    }
  }
  const items = [...best.values()].sort((a, b) => better(a, b) || compareUtf8(a.id, b.id));
  return { seeds: seedIds, items, truncated, evidence: "graph" };
}

/** Seeds for impact(): the File nodes of changed paths. */
export function impactSeedsOfFiles(paths: readonly RepoPath[]): EntityRef[] {
  return paths.map((p) => fileRef(p));
}
