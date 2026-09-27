/**
 * Edge endpoint matrix (docs/04-project-graph.md Edge table). GraphStore stores any edge; the Graph
 * Builder and graph.check() enforce this matrix so an illegal relation never reaches the database.
 */
import type { EntityType } from "@duo-director/core";
import type { GraphEdgeType } from "../store/types.js";

export const EDGE_ENDPOINTS: Readonly<Record<GraphEdgeType, readonly (readonly [EntityType, EntityType])[]>> = {
  CONTAINS: [["project", "milestone"], ["project", "file"], ["file", "symbol"], ["symbol", "symbol"], ["file", "test"]],
  REQUIRES: [["milestone", "requirement"], ["requirement", "requirement"], ["issue", "issue"]],
  IMPLEMENTS: [["symbol", "requirement"], ["file", "requirement"]],
  CALLS: [["symbol", "symbol"]],
  IMPORTS: [["file", "file"]],
  GOVERNS: [["decision", "requirement"], ["decision", "issue"], ["decision", "file"], ["decision", "symbol"]],
  TRACKED_BY: [["requirement", "issue"]],
  VALIDATED_BY: [["symbol", "test"], ["requirement", "test"]],
  CHANGED_WITH: [["file", "file"]],
  SUPERSEDES: [["decision", "decision"]],
};

export function isEdgeEndpointAllowed(type: GraphEdgeType, from: EntityType, to: EntityType): boolean {
  return EDGE_ENDPOINTS[type].some(([f, t]) => f === from && t === to);
}
