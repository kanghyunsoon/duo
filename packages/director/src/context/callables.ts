/**
 * Logical C++ callables (T24.3, C218): Symbols joined by the declaration links the Indexer recorded (a
 * header declaration and its out-of-line definition, proven by syntax). The Graph keeps both Symbols,
 * their IDs and their Evidence; the Context Compiler treats a group as one target: an ambiguous name
 * whose candidates are all one group seeds the group, and the group is one Packet item that shows every
 * declaration and definition range.
 */
import { compareUtf8, symbolRef, type RepoPath } from "@duo-director/core";
import { readDeclarationLinks, type DeclarationEnd, type GraphNode, type GraphReader } from "@duo-director/graph";

export interface CallableGroups {
  /** Symbol ID → the sorted IDs of its group (the same array for every member). Symbols without a link are absent. */
  readonly groups: ReadonlyMap<string, readonly string[]>;
  /** The Graph node of every group member. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
}

export const NO_CALLABLE_GROUPS: CallableGroups = { groups: new Map(), nodes: new Map() };

const refOf = (e: DeclarationEnd) => {
  const prefix = `sym:${e.path}#`;
  return e.symbol.startsWith(prefix) ? symbolRef(e.path as RepoPath, e.symbol.slice(prefix.length)) : undefined;
};

export function callableGroups(graph: GraphReader): CallableGroups {
  const links = readDeclarationLinks(graph);
  if (links.length === 0) return NO_CALLABLE_GROUPS;
  const parent = new Map<string, string>();
  const nodes = new Map<string, GraphNode>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    for (let y = x; y !== r;) { const next = parent.get(y) as string; parent.set(y, r); y = next; }
    return r;
  };
  const exists = (e: DeclarationEnd) => {
    const ref = refOf(e);
    const node = ref === undefined ? undefined : graph.getNode(ref);
    if (node !== undefined) nodes.set(e.symbol, node);
    return node !== undefined;
  };
  for (const l of links) {
    // A link to a Symbol the Graph does not have (it cannot happen after one transaction) is ignored.
    if (!exists(l.declaration) || !exists(l.definition)) continue;
    for (const id of [l.declaration.symbol, l.definition.symbol]) if (!parent.has(id)) parent.set(id, id);
    const a = find(l.declaration.symbol);
    const b = find(l.definition.symbol);
    if (a !== b) parent.set(compareUtf8(a, b) < 0 ? b : a, compareUtf8(a, b) < 0 ? a : b);
  }
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) { const r = find(id); members.set(r, [...(members.get(r) ?? []), id]); }
  const out = new Map<string, readonly string[]>();
  for (const list of members.values()) {
    const sorted = Object.freeze([...list].sort(compareUtf8));
    for (const id of sorted) out.set(id, sorted);
  }
  return { groups: out, nodes };
}

/** True when there are at least two nodes and all of them belong to one group. */
export function oneGroup(groups: CallableGroups, nodes: readonly Pick<GraphNode, "id">[]): boolean {
  const g = nodes[0] === undefined ? undefined : groups.groups.get(nodes[0].id);
  return g !== undefined && nodes.length > 1 && nodes.every((n) => groups.groups.get(n.id) === g);
}

