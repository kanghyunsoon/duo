/**
 * Node payload schemas (TASK-007). A payload is a small lookup record, not a copy of the source:
 * titles, states and kinds only. Full text is read again from the Source of Truth via node.source.
 * Locations live in the node's source column, content fingerprints in its contentHash column.
 */
import type { EntityType } from "@duo-director/core";
import { z } from "zod";

const location = z.strictObject({
  path: z.string(),
  startLine: z.number().int().optional(),
  startColumn: z.number().int().optional(),
  endLine: z.number().int().optional(),
  endColumn: z.number().int().optional(),
});
const id = z.string().min(1);

export const NODE_PAYLOAD_SCHEMAS = {
  project: z.strictObject({
    name: z.string(),
    currentMilestone: id.optional(),
    git: z.strictObject({
      headOid: z.string().optional(),
      branch: z.string().optional(),
      detached: z.boolean(),
      /** Project Truth Issue IDs found in the branch name. */
      branchIssueIds: z.array(id),
    }).optional(),
  }),
  milestone: z.strictObject({ title: z.string(), state: z.enum(["planned", "active", "done"]) }),
  requirement: z.strictObject({
    title: z.string(),
    status: z.enum(["planned", "in_progress", "done", "deferred"]),
    milestone: id.optional(),
    priority: z.enum(["must", "should", "could"]).optional(),
  }),
  decision: z.strictObject({
    decisionKind: z.enum(["decision", "constraint"]),
    title: z.string(),
    state: z.enum(["proposed", "confirmed", "superseded", "rejected", "draft", "retired"]),
    enforcement: z.enum(["warn", "block"]).optional(),
  }),
  issue: z.strictObject({
    title: z.string(),
    status: z.enum(["todo", "in_progress", "review", "done"]),
    milestone: id.optional(),
    /** Recent commits whose message names this Issue (provenance, newest first). */
    commits: z.array(z.string()).optional(),
  }),
  file: z.strictObject({
    path: z.string(),
    state: z.enum(["tracked", "untracked"]),
    fingerprintMode: z.enum(["normalized-text", "raw"]),
    language: z.string().optional(),
    analysis: z.enum(["complete", "partial", "failed"]).optional(),
    analyzerVersion: z.string().optional(),
  }),
  symbol: z.strictObject({
    name: z.string(),
    qualifiedName: z.string(),
    kind: z.enum(["class", "interface", "type-alias", "enum", "function", "method", "constructor", "getter", "setter", "accessor", "struct", "record", "delegate", "namespace", "property", "destructor"]),
    exported: z.boolean(),
    memberScope: z.enum(["static", "instance"]).optional(),
    parent: z.string().optional(),
    additionalLocations: z.array(location).optional(),
    analyzerVersion: z.string(),
  }),
  test: z.strictObject({
    name: z.string(),
    fullName: z.string(),
    frameworkHint: z.enum(["vitest", "jest", "node-test", "junit4", "junit5", "nunit", "xunit", "mstest", "googletest", "catch2", "unreal-automation", "pytest", "unittest", "unknown"]),
    confidence: z.enum(["explicit", "heuristic"]),
    modifier: z.enum(["skip", "only", "todo"]).optional(),
    enclosingSuite: z.string().optional(),
    analyzerVersion: z.string(),
  }),
} as const satisfies Record<EntityType, z.ZodType>;

export type NodePayload<T extends EntityType> = z.infer<(typeof NODE_PAYLOAD_SCHEMAS)[T]>;

/** Validates a payload for its node type; returns the first problem, or undefined. */
export function payloadProblem(type: EntityType, payload: unknown): string | undefined {
  const r = NODE_PAYLOAD_SCHEMAS[type].safeParse(payload);
  return r.success ? undefined : r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
