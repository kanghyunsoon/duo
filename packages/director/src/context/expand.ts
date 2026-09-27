/**
 * Relevant graph traversal (05 §2, TASK-010). Weighted best-first search from the seeds: a node's
 * order value is its seed strength × the product of the hop weights on its best path (policy.ts).
 * Unlike plain BFS, a CHANGED_WITH neighbour never outranks a declared relation just because it
 * sorts first, and the node limit keeps the best candidates, not the first visited.
 *
 * Hubs (Project, Milestone, Decision, Issue) are expanded only from their own seed entry (depth
 * 0): a Decision that governs ten Requirements or a Milestone that requires them all would
 * otherwise pull every sibling in at full weight. A hub that is also a weak (keyword) seed but was
 * reached first through a stronger path is not expanded. SUPERSEDES is not followed here; the
 * active Decision is found from Project Truth (candidates.ts).
 */
import { compareUtf8, parseNodeId, type EntityType } from "@duo-director/core";
import type { GraphEdge, GraphNode, GraphReader } from "@duo-director/graph";
import { EDGE_WEIGHTS } from "./policy.js";
import type { EvidenceStep } from "./types.js";

export interface Candidate {
  readonly node: GraphNode;
  readonly score: number;
  readonly depth: number;
  /** Seed node ID the best path starts from. */
  readonly seed: string;
  readonly steps: readonly EvidenceStep[];
}

export interface Expansion {
  /** Best first: score desc, depth asc, id (UTF-8). */
  readonly candidates: readonly Candidate[];
  /** nodeLimit or an edge limit cut the traversal short. */
  readonly truncated: boolean;
}

export interface ExpandOptions {
  readonly maxDepth: number;
  readonly nodeLimit: number;
  readonly edgeLimit: number;
}

const HUBS: ReadonlySet<EntityType> = new Set(["project", "milestone", "decision", "issue"]);

/** Display reference of a node ID ("AUTH-03", "src/a.ts#A.b"). */
export function displayRef(id: string): string {
  const ref = parseNodeId(id);
  if (ref === undefined) return id;
  switch (ref.type) {
    case "project": return "project";
    case "file": return ref.path;
    case "symbol": return `${ref.path}#${ref.symbol}`;
    case "test": return `${ref.path}#${ref.name}`;
    default: return ref.id;
  }
}

function better(a: Candidate, b: Candidate): number {
  return b.score - a.score || a.depth - b.depth || compareUtf8(a.node.id, b.node.id);
}

/** Minimal binary heap ordered by better(). */
class Heap {
  private readonly items: Candidate[] = [];
  get size(): number { return this.items.length; }
  push(c: Candidate): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (better(a[i] as Candidate, a[p] as Candidate) >= 0) break;
      [a[i], a[p]] = [a[p] as Candidate, a[i] as Candidate];
      i = p;
    }
  }
  pop(): Candidate | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && better(a[l] as Candidate, a[m] as Candidate) < 0) m = l;
        if (r < a.length && better(a[r] as Candidate, a[m] as Candidate) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as Candidate, a[i] as Candidate];
        i = m;
      }
    }
    return top;
  }
}

function step(edge: GraphEdge): EvidenceStep {
  const provenance = typeof edge.metadata.provenance === "string" ? edge.metadata.provenance : "unknown";
  return { from: displayRef(edge.from), type: edge.type, to: displayRef(edge.to), provenance };
}

export function expandCandidates(store: GraphReader, seeds: readonly { readonly id: string; readonly strength: number }[], options: ExpandOptions): Expansion {
  const heap = new Heap();
  const best = new Map<string, number>();
  const seedIds = new Set(seeds.map((s) => s.id));
  for (const s of seeds) {
    const ref = parseNodeId(s.id);
    const node = ref === undefined ? undefined : store.getNode(ref);
    if (node === undefined) continue;
    heap.push({ node, score: s.strength, depth: 0, seed: s.id, steps: [] });
    best.set(s.id, Math.max(best.get(s.id) ?? 0, s.strength));
  }
  const done = new Map<string, Candidate>();
  let truncated = false;
  while (heap.size > 0) {
    const c = heap.pop() as Candidate;
    if (done.has(c.node.id)) continue;
    if (done.size >= options.nodeLimit) { truncated = true; break; }
    done.set(c.node.id, c);
    if (c.depth >= options.maxDepth || (HUBS.has(c.node.type) && !(c.depth === 0 && seedIds.has(c.node.id)))) continue;
    const adjacent = store.adjacentEdges([c.node.ref], { direction: "both", limit: options.edgeLimit });
    if (adjacent.truncated) truncated = true;
    for (const edge of adjacent.edges) {
      if (edge.type === "SUPERSEDES") continue;
      const other = edge.from === c.node.id ? edge.to : edge.from;
      if (done.has(other) || other.startsWith("project:")) continue;
      const score = c.score * EDGE_WEIGHTS[edge.type];
      if (score <= (best.get(other) ?? 0)) continue;
      const ref = parseNodeId(other);
      const node = ref === undefined ? undefined : store.getNode(ref);
      if (node === undefined) continue;
      best.set(other, score);
      heap.push({ node, score, depth: c.depth + 1, seed: c.seed, steps: [...c.steps, step(edge)] });
    }
  }
  return { candidates: [...done.values()].sort(better), truncated };
}
