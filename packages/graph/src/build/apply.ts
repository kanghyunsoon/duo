/**
 * Applies a GraphBuildPlan in one GraphStore transaction (TASK-007). An invalid plan is never
 * written, and a failure inside the transaction rolls everything back: the database is never left
 * half-built.
 */
import { createDiagnostic, failure, success, type ParseResult } from "@duo-director/core";
import { GraphStoreError, type GraphStore } from "../store/types.js";
import type { GraphBuildPlan } from "./types.js";

const PAGE = 1000;

/** Replaces the whole graph with the plan (full build). */
export function applyGraphPlan(store: GraphStore, plan: GraphBuildPlan): ParseResult<{ readonly nodes: number; readonly edges: number }> {
  if (!plan.valid) {
    return failure([
      createDiagnostic("GRAPH_WRITE_REFUSED", "The graph plan did not pass validation; nothing was written"),
      ...plan.diagnostics.filter((d) => d.severity === "error"),
    ]);
  }
  try {
    store.transaction((tx) => {
      for (let page = tx.listNodes({ limit: PAGE }); page.length > 0; page = tx.listNodes({ limit: PAGE })) tx.deleteNodes(page.map((n) => n.ref));
      tx.upsertNodes(plan.nodes);
      tx.upsertEdges(plan.edges);
    });
  } catch (error) {
    const code = error instanceof GraphStoreError ? error.code : "INTERNAL";
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Graph write rolled back (${code}): ${(error as Error).message}`)]);
  }
  return success({ nodes: plan.nodes.length, edges: plan.edges.length });
}
