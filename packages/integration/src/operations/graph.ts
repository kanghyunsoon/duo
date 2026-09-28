/**
 * duo trace / impact (CLI trace/impact, MCP duo_trace/duo_impact): the Graph primitives as they are,
 * bounded, with truncated. Impact is what the DUO Graph records, not every affected line of code.
 */
import { definitionRef, fileRef, isDefinitionId, normalizeRepoPath, parseNodeId, type EntityRef } from "@duo-director/core";
import { analysisLimitations } from "@duo-director/director";
import { impact, inspectIndex, trace, type GraphReader } from "@duo-director/graph";
import { guarded, project, withGraphReader, withRegistry, type Operation, type OperationOptions, type Failure } from "./common.js";

export const TRACE_FORMAT = "duo.trace/1";
export const IMPACT_FORMAT = "duo.impact/1";
export const IMPACT_NOTICE = "Relations recorded in the DUO Graph (direct, structural, historical); not a complete list of everything the change can affect.";

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

export function projectGraphQuery(root: string, kind: "trace" | "impact", node: string, depth: number, options: OperationOptions = {}): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    return withRegistry(options.registry, (registry) => withGraphReader(root, async (graph) => {
      const index = (await inspectIndex(root, { graph, registry })).value?.status ?? "unknown";
      const format = kind === "trace" ? TRACE_FORMAT : IMPACT_FORMAT;
      const ref = resolveNode(graph, node);
      if (ref === undefined) return { kind: "ok" as const, diagnostics: [], payload: { format, status: "not-found", index, node } };
      if (kind === "trace") {
        const r = trace(graph, ref, { maxDepth: depth });
        return { kind: "ok" as const, diagnostics: [], payload: {
          format, status: "found", index, node: ref, depth, truncated: r.truncated,
          nodes: r.nodes.map((n) => ({ id: n.node.id, type: n.node.type, depth: n.depth })), edges: r.edges.map((e) => ({ from: e.from, type: e.type, to: e.to })),
        } };
      }
      const r = impact(graph, [ref], { maxDepth: depth });
      // T18.0 (additive): what the analyzers of the files involved cannot record (file-only files, syntactic imports, limited CALLS).
      const languages = new Map<string, string | undefined>();
      for (const e of [ref, ...r.items.map((x) => x.ref)]) {
        if ((e.type !== "file" && e.type !== "symbol" && e.type !== "test") || languages.has(e.path)) continue;
        const language = graph.getNode(fileRef(e.path))?.payload.language;
        languages.set(e.path, typeof language === "string" ? language : undefined);
      }
      return { kind: "ok" as const, diagnostics: [], payload: {
        format, status: "found", index, node: ref, depth, truncated: r.truncated, seeds: r.seeds, items: r.items, evidence: r.evidence, notice: IMPACT_NOTICE,
        limitations: analysisLimitations(languages),
      } };
    }));
  });
}
