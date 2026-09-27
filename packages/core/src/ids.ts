import { normalizeRepoPath, type RepoPath } from "./paths.js";

/**
 * Definition IDs: Requirement, Decision (ADR), Issue (Task), Milestone. Globally unique.
 * Examples: AUTH-03, REQ-CONTEXT-001, D-004, ADR-005, TASK-012A, GAME-42, M1 (ADR-014).
 */
export const DEFINITION_ID_PATTERN = /^(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Z]?|M\d+)$/;

/** Acceptance criteria: AC-<task number>-<sequence>, e.g. AC-010-02, AC-012A-01. */
export const ACCEPTANCE_ID_PATTERN = /^AC-\d{3}[A-Z]?-\d{2}$/;

/**
 * Decision proposals. DecisionService allocates P-### in sequence (T09: time is not an identity);
 * the earlier P-YYYYMMDD-xxxxxx form is still read.
 */
export const PROPOSAL_ID_PATTERN = /^P-(?:\d{3,}|\d{8}-[a-z0-9]{6})$/;

export const DEFINITION_TYPES = ["milestone", "requirement", "decision", "issue"] as const;
export type DefinitionType = (typeof DEFINITION_TYPES)[number];
export const ENTITY_TYPES = ["project", ...DEFINITION_TYPES, "file", "symbol", "test"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface ProjectRef { readonly type: "project" }
export interface DefinitionRef { readonly type: DefinitionType; readonly id: string }
export interface FileRef { readonly type: "file"; readonly path: RepoPath }
export interface SymbolRef { readonly type: "symbol"; readonly path: RepoPath; readonly symbol: string }
export interface TestRef { readonly type: "test"; readonly path: RepoPath; readonly name: string }

/** Common reference to any Project Graph entity. Node IDs are derived from it with nodeId(). */
export type EntityRef = ProjectRef | DefinitionRef | FileRef | SymbolRef | TestRef;

/** Node ID prefixes (docs/04-project-graph.md). */
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

export const PROJECT_REF: ProjectRef = { type: "project" };

export function isDefinitionId(value: string): boolean {
  return DEFINITION_ID_PATTERN.test(value);
}

export function isDefinitionType(type: EntityType): type is DefinitionType {
  return (DEFINITION_TYPES as readonly string[]).includes(type);
}

export function definitionRef(type: DefinitionType, id: string): DefinitionRef {
  return { type, id };
}

export function fileRef(path: RepoPath): FileRef {
  return { type: "file", path };
}

export function symbolRef(path: RepoPath, symbol: string): SymbolRef {
  return { type: "symbol", path, symbol };
}

export function testRef(path: RepoPath, name: string): TestRef {
  return { type: "test", path, name };
}

/** Characters escaped inside node ID components: the escape char, the component separator and controls. */
// eslint-disable-next-line no-control-regex -- control characters are escaped on purpose
const ESCAPED = /[%#\u0000-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- control characters are escaped on purpose
const ESCAPED_ONE = /^[%#\u0000-\u001F\u007F]$/;

function encodeComponent(value: string): string {
  return value.replace(ESCAPED, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** Inverse of encodeComponent. Accepts only canonical escapes, so decoding is unambiguous. */
function decodeComponent(value: string): string | undefined {
  let invalid = false;
  const decoded = value.replace(/%([0-9A-F]{2})|%/g, (match, hex: string | undefined) => {
    const c = hex === undefined ? "" : String.fromCharCode(parseInt(hex, 16));
    if (hex === undefined || !ESCAPED_ONE.test(c)) invalid = true;
    return c;
  });
  return invalid ? undefined : decoded;
}

/**
 * Stable node ID. Components are escaped (% → %25, # → %23, control characters → %XX), so
 * "sym:<path>#<symbol>" splits unambiguously and parseNodeId(nodeId(ref)) always returns ref.
 * Unicode and letter case are kept as spelled.
 */
export function nodeId(ref: EntityRef): string {
  const prefix = NODE_ID_PREFIX[ref.type];
  switch (ref.type) {
    case "project":
      return `${prefix}:root`;
    case "file":
      return `${prefix}:${encodeComponent(ref.path)}`;
    case "symbol":
      return `${prefix}:${encodeComponent(ref.path)}#${encodeComponent(ref.symbol)}`;
    case "test":
      return `${prefix}:${encodeComponent(ref.path)}#${encodeComponent(ref.name)}`;
    default:
      return `${prefix}:${encodeComponent(ref.id)}`;
  }
}

function decodePath(component: string): RepoPath | undefined {
  const decoded = decodeComponent(component);
  if (decoded === undefined) return undefined;
  const canonical = normalizeRepoPath(decoded).value;
  return canonical === decoded ? canonical : undefined;
}

/** Parses a node ID produced by nodeId(). Returns undefined for anything nodeId() cannot produce. */
export function parseNodeId(value: string): EntityRef | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const prefix = value.slice(0, colon);
  const body = value.slice(colon + 1);
  const type = ENTITY_TYPES.find((t) => NODE_ID_PREFIX[t] === prefix);
  if (type === undefined || body === "") return undefined;
  if (type === "project") return body === "root" ? PROJECT_REF : undefined;
  if (type === "file") {
    const path = body.includes("#") ? undefined : decodePath(body);
    return path === undefined ? undefined : fileRef(path);
  }
  if (type === "symbol" || type === "test") {
    const parts = body.split("#");
    if (parts.length !== 2) return undefined;
    const path = decodePath(parts[0] ?? "");
    const name = decodeComponent(parts[1] ?? "");
    if (path === undefined || name === undefined || name === "") return undefined;
    return type === "symbol" ? symbolRef(path, name) : testRef(path, name);
  }
  const id = body.includes("#") ? undefined : decodeComponent(body);
  return id !== undefined && isDefinitionId(id) ? definitionRef(type, id) : undefined;
}

export function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return nodeId(a) === nodeId(b);
}
