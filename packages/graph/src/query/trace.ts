/**
 * trace(node, depth) (04 탐색, TASK-008): the Project Truth context of a node. Follows the
 * traceability relations in both directions (REQUIRES, TRACKED_BY, GOVERNS, IMPLEMENTS, VALIDATED_BY,
 * SUPERSEDES): upwards to Requirements, Decisions, Issues and Milestones, downwards to the Symbols,
 * Files and Tests linked to them. Structural (CONTAINS), code (CALLS, IMPORTS) and historical
 * (CHANGED_WITH) edges are not followed. A bounded, deterministic traverse().
 */
import type { EntityRef } from "@duo-director/core";
import type { GraphEdgeType, GraphReader } from "../store/types.js";
import { traverse, type TraversalResult } from "../traverse.js";

export const TRACE_EDGE_TYPES: readonly GraphEdgeType[] = ["REQUIRES", "TRACKED_BY", "GOVERNS", "IMPLEMENTS", "VALIDATED_BY", "SUPERSEDES"];

export function trace(store: GraphReader, seed: EntityRef, options: { readonly maxDepth?: number; readonly nodeLimit?: number } = {}): TraversalResult {
  return traverse(store, [seed], { maxDepth: options.maxDepth ?? 2, nodeLimit: options.nodeLimit ?? 200, direction: "both", edgeTypes: TRACE_EDGE_TYPES });
}
