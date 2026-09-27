import type { RepoPath } from "./paths.js";

/**
 * Definition IDs: Requirement, Decision (ADR), Issue (Task), Milestone. Globally unique.
 * Examples: AUTH-03, REQ-CONTEXT-001, D-004, ADR-005, TASK-012A, GAME-42, M1 (ADR-014).
 */
export const DEFINITION_ID_PATTERN = /^(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$/;

/** Acceptance criteria: AC-<task number>-<sequence>, e.g. AC-010-02, AC-012A-01. */
export const ACCEPTANCE_ID_PATTERN = /^AC-\d{3}[A-Z]?-\d{2}$/;

/** Decision proposals: P-YYYYMMDD-xxxxxx. */
export const PROPOSAL_ID_PATTERN = /^P-\d{8}-[a-z0-9]{6}$/;

export const ENTITY_TYPES = ["project", "milestone", "requirement", "decision", "issue", "file", "symbol", "test"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Common reference to any Project Graph entity. */
export interface EntityRef {
  readonly type: EntityType;
  readonly id: string;
}

/** Node ID prefixes (docs/04-project-graph.md). The Graph itself is TASK-007. */
const NODE_ID_PREFIX = {
  project: "project",
  milestone: "ms",
  requirement: "req",
  decision: "dec",
  issue: "issue",
  file: "file",
  symbol: "sym",
  test: "test",
} as const satisfies Record<EntityType, string>;

export const PROJECT_REF: EntityRef = { type: "project", id: "root" };

export function isDefinitionId(value: string): boolean {
  return DEFINITION_ID_PATTERN.test(value);
}

/** Stable node ID, e.g. "req:AUTH-03", "file:src/a.ts", "sym:src/a.ts#AuthService.refresh". */
export function nodeId(ref: EntityRef): string {
  return `${NODE_ID_PREFIX[ref.type]}:${ref.id}`;
}

export function parseNodeId(value: string): EntityRef | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return undefined;
  const prefix = value.slice(0, colon);
  const type = ENTITY_TYPES.find((t) => NODE_ID_PREFIX[t] === prefix);
  return type === undefined ? undefined : { type, id: value.slice(colon + 1) };
}

export function fileRef(path: RepoPath): EntityRef {
  return { type: "file", id: path };
}

export function symbolRef(path: RepoPath, qualifiedName: string): EntityRef {
  return { type: "symbol", id: `${path}#${qualifiedName}` };
}

export function testRef(path: RepoPath, name: string): EntityRef {
  return { type: "test", id: `${path}#${name}` };
}
