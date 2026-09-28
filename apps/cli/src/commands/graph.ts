/**
 * duoctl trace <node> / duoctl impact <node> (T15): the Graph primitives as they are. Results are
 * bounded (depth, node limit) and say when they were truncated. Impact is what the DUO Graph records,
 * not every affected line of code. Read-only.
 */
import { definitionRef, fileRef, isDefinitionId, normalizeRepoPath, parseNodeId, type EntityRef } from "@duo-director/core";
import { impact, inspectIndex, trace, type GraphReader } from "@duo-director/graph";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { requireProject, usage, withReader, withRegistry, type Env } from "./shared.js";

/** A node ID, a definition ID, a repository path, or a unique qualified symbol name. */
export function resolveNode(graph: GraphReader, arg: string): EntityRef | undefined {
  const parsed = parseNodeId(arg);
  if (parsed !== undefined && graph.getNode(parsed) !== undefined) return parsed;
  if (isDefinitionId(arg)) {
    for (const type of ["requirement", "decision", "issue", "milestone"] as const) {
      const ref = definitionRef(type, arg);
      if (graph.getNode(ref) !== undefined) return ref;
    }
  }
  const p = normalizeRepoPath(arg).value;
  if (p !== undefined && graph.getNode(fileRef(p)) !== undefined) return fileRef(p);
  const matches: EntityRef[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = graph.listNodes({ type: "symbol", limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
    for (const n of page) if (n.payload.qualifiedName === arg) matches.push(n.ref);
    if (page.length < 1000) break;
    afterId = page[page.length - 1]?.id;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function graphCommand(env: Env, kind: "trace" | "impact", node: string, depthArg: string | undefined): Promise<Outcome> {
  const project = requireProject(env, kind);
  if (project.value === undefined) return project.outcome as Outcome;
  const depth = depthArg === undefined ? 2 : Number(depthArg);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) return usage(kind, "--depth must be 1, 2 or 3");
  return withRegistry((registry) => withReader(env.root, async (graph) => {
    const index = (await inspectIndex(env.root, { graph, registry })).value?.status ?? "unknown";
    const ref = resolveNode(graph, node);
    if (ref === undefined) return failed(kind, EXIT.ERROR, [], [t(env.locale, "graph.not-found", { node })], { index, node });
    const human: string[] = [];
    if (index !== "current") human.push(t(env.locale, "index.required", { status: index }));
    if (kind === "trace") {
      const r = trace(graph, ref, { maxDepth: depth });
      human.push(...r.nodes.map((n) => `${"  ".repeat(n.depth)}${n.node.id}`), ...r.edges.map((e) => `  ${e.from} -${e.type}-> ${e.to}`));
      if (r.truncated) human.push(t(env.locale, "graph.truncated"));
      return { command: kind, exitCode: EXIT.OK, diagnostics: [], human, result: { index, node: ref, depth, nodes: r.nodes.map((n) => ({ id: n.node.id, type: n.node.type, depth: n.depth })), edges: r.edges.map((e) => ({ from: e.from, type: e.type, to: e.to })), truncated: r.truncated } };
    }
    const r = impact(graph, [ref], { maxDepth: depth });
    human.push(...r.items.map((i) => `  ${i.relation.padEnd(10)} d${i.depth}  ${i.id}  (via ${i.via.edge})`), t(env.locale, "graph.impact-note"));
    if (r.truncated) human.push(t(env.locale, "graph.truncated"));
    return { command: kind, exitCode: EXIT.OK, diagnostics: [], human, result: { index, node: ref, depth, seeds: r.seeds, items: r.items, truncated: r.truncated, evidence: r.evidence } };
  }));
}
