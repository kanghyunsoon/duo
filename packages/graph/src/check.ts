/**
 * graph.check() (TASK-007, REQ-GRAPH-003): consistency invariants of docs/04-project-graph.md on a
 * stored graph. 1 edge endpoints exist, 2 endpoint types match the 04 table, 3 File nodes ↔
 * fingerprints (outside .duo-project/), 4 Symbol/Test nodes have exactly one containing File,
 * 6 definition IDs are unique across types, 7 SUPERSEDES has no self-loop or cycle.
 * Invariant 4 also checks ownership (TASK-008): a Symbol/Test is owned by the file that contains
 * it, and no other node has an owner. Invariant 5 (incremental = clean full rebuild) compares two
 * graphs: dumpGraph() gives the canonical rows to compare.
 */
import { CONTAINER_SYMBOL_KINDS, type FileFingerprint } from "@duo-director/analyzer";
import { compareUtf8, createDiagnostic, nodeId, STATE_DIR_NAME, type Diagnostic } from "@duo-director/core";
import type { GraphEdge, GraphNode, GraphReader } from "./store/types.js";
import { isEdgeEndpointAllowed } from "./build/endpoints.js";
import { edgeRow, nodeRow } from "./build/scope.js";

const PAGE = 1000;
const violation = (n: number, message: string) => createDiagnostic("GRAPH_INVARIANT_VIOLATED", `Invariant ${n}: ${message}`);

export interface GraphCheckOptions {
  /** When given, invariant 3 is checked against these fingerprints. */
  readonly fingerprints?: readonly FileFingerprint[];
}

function allNodes(store: GraphReader): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (let page = store.listNodes({ limit: PAGE }); page.length > 0; page = store.listNodes({ afterId: page.at(-1)?.id ?? "", limit: PAGE })) {
    nodes.push(...page);
    if (page.length < PAGE) break;
  }
  return nodes;
}

function allEdges(store: GraphReader, nodes: readonly GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i += 200) {
    const r = store.adjacentEdges(nodes.slice(i, i + 200).map((n) => n.ref), { direction: "outgoing", limit: 1_000_000 });
    edges.push(...r.edges);
  }
  return edges;
}

export function checkGraph(store: GraphReader, options: GraphCheckOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodes = allNodes(store);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges = allEdges(store, nodes);
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from === undefined || to === undefined) {
      diagnostics.push(violation(1, `${e.from} -${e.type}-> ${e.to} has a missing endpoint`));
      continue;
    }
    if (!isEdgeEndpointAllowed(e.type, from.type, to.type)) diagnostics.push(violation(2, `${e.from} -${e.type}-> ${e.to} is not allowed by 04`));
    else if (e.type === "CONTAINS" && from.type === "symbol" && !CONTAINER_SYMBOL_KINDS.has(from.payload.kind as never)) {
      diagnostics.push(violation(2, `${e.from} contains ${e.to} but is not a container symbol (class, interface, enum, struct, record, namespace)`));
    }
  }
  if (options.fingerprints !== undefined) {
    const expected = new Set(options.fingerprints.filter((f) => !f.path.startsWith(`${STATE_DIR_NAME}/`)).map((f) => nodeId({ type: "file", path: f.path })));
    for (const n of nodes) if (n.type === "file" && !expected.has(n.id)) diagnostics.push(violation(3, `${n.id} has no fingerprint`));
    for (const id of expected) if (!byId.has(id)) diagnostics.push(violation(3, `fingerprinted file ${id} has no node`));
  }
  const containers = new Map<string, number>();
  for (const e of edges) if (e.type === "CONTAINS" && byId.get(e.from)?.type === "file") containers.set(e.to, (containers.get(e.to) ?? 0) + 1);
  for (const n of nodes) {
    if ((n.type === "symbol" || n.type === "test") && containers.get(n.id) !== 1) diagnostics.push(violation(4, `${n.id} is contained by ${containers.get(n.id) ?? 0} files`));
    const owner = n.ref.type === "symbol" || n.ref.type === "test" ? n.ref.path : undefined;
    if (n.ownerFile !== owner) diagnostics.push(violation(4, `${n.id} has owner file ${n.ownerFile ?? "none"}, expected ${owner ?? "none"}`));
  }
  const definitionType = new Map<string, string>();
  for (const n of nodes) {
    if (n.ref.type !== "requirement" && n.ref.type !== "decision" && n.ref.type !== "issue" && n.ref.type !== "milestone") continue;
    const seen = definitionType.get(n.ref.id);
    if (seen !== undefined && seen !== n.ref.type) diagnostics.push(violation(6, `ID ${n.ref.id} is both a ${seen} and a ${n.ref.type}`));
    definitionType.set(n.ref.id, n.ref.type);
  }
  const supersedes = new Map<string, string[]>();
  for (const e of edges) if (e.type === "SUPERSEDES") supersedes.set(e.from, [...(supersedes.get(e.from) ?? []), e.to]);
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    state.set(id, "visiting");
    for (const next of supersedes.get(id) ?? []) {
      if (state.get(next) === "visiting") diagnostics.push(violation(7, `SUPERSEDES cycle ${[...path, id, next].join(" → ")}`));
      else if (state.get(next) === undefined) visit(next, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const id of [...supersedes.keys()].sort(compareUtf8)) if (state.get(id) === undefined) visit(id, []);
  return diagnostics;
}

/** Canonical rows of every node and edge, sorted: two graphs are equal when their dumps are equal (invariant 5). */
export function dumpGraph(store: GraphReader): { readonly nodes: readonly string[]; readonly edges: readonly string[] } {
  const nodes = allNodes(store);
  const byId = new Map(nodes.map((n) => [n.id, n.ref] as const));
  const edges = allEdges(store, nodes).map((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return from === undefined || to === undefined ? `dangling ${e.from} ${e.type} ${e.to}` : edgeRow({ from, type: e.type, to, metadata: e.metadata });
  });
  return { nodes: nodes.map((n) => nodeRow(n)).sort(compareUtf8), edges: edges.sort(compareUtf8) };
}
