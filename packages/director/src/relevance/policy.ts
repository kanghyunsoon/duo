/**
 * Intent relevance policy (T10.1): one deterministic answer to "does this piece of intent concern
 * the current task?", shared by the Context Compiler (Constraint selection), Knowledge Gap
 * assessment (declared gaps) and, later, Review. No score: direct, related or none, always with
 * the reasons that decided it, so a later consumer can cite the same evidence.
 *
 * The scope is the task's candidate context as an ordered list: the Compiler passes its ranked
 * traversal candidates, Gap assessment passes the Packet's items and omitted candidates.
 */
import { compileRepoPattern, type Constraint, type DeclaredGap, type EntityType, type ProjectTruth, type RepoPath } from "@duo-director/core";
import { searchTerms } from "./terms.js";

export const RELEVANCE_POLICY_VERSION = "1";

export type Relevance = "direct" | "related" | "none";

export type RelevanceReasonCode =
  | "task-seed" | "near-intent" | "governed-by-active-decision" | "in-context"
  | "match-path" | "match-symbol" | "match-keyword" | "keyword-overlap"
  | "project-scope" | "not-in-context";

export interface RelevanceReason {
  readonly code: RelevanceReasonCode;
  /** The entity or task term the reason points at. */
  readonly ref?: string;
  readonly detail?: string;
}

export interface RelevanceResult {
  readonly relevance: Relevance;
  readonly reasons: readonly RelevanceReason[];
  /** Scope entry (node ID) the decision rests on, when there is one. */
  readonly matched?: string;
  /** Constraint rule that matched. */
  readonly field?: "match.paths" | "match.symbols" | "match.keywords";
}

export interface ScopeEntry {
  /** Node ID. */
  readonly id: string;
  /** Definition ID, path or path#name. */
  readonly ref: string;
  readonly type: EntityType;
  /** Edges from a seed; undefined when the entry was a candidate but is not in the Packet. */
  readonly hops: number | undefined;
  readonly seed: boolean;
  /** Symbols and files. */
  readonly path?: string;
  readonly qualifiedName?: string;
}

export interface RelevanceScope {
  /** In rank order: the first matching entry is the evidence. */
  readonly entries: readonly ScopeEntry[];
  readonly taskText: string;
}

function wildcard(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) source += ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
  return new RegExp(`^${source}$`, "u");
}

/**
 * Constraints have no graph edges (T07). A Constraint concerns the task when a code entry matches
 * its match.paths or match.symbols (direct if that entry is a seed or one edge from one, else
 * related), or when the task text contains one of its match.keywords (related).
 */
export function matchConstraint(constraint: Constraint, scope: RelevanceScope): RelevanceResult {
  const paths = constraint.match.paths.flatMap((p) => compileRepoPattern(p) ?? []);
  const symbols = constraint.match.symbols.map(wildcard);
  for (const e of scope.entries) {
    if (e.type !== "symbol" && e.type !== "file") continue;
    const level: Relevance = e.hops !== undefined && e.hops <= 1 ? "direct" : "related";
    if (paths.some((m) => m((e.path ?? "") as RepoPath))) {
      return { relevance: level, reasons: [{ code: "match-path", ref: e.ref, detail: constraint.match.paths.join(", ") }], matched: e.id, field: "match.paths" };
    }
    if (e.type === "symbol" && symbols.some((re) => re.test(e.qualifiedName ?? ""))) {
      return { relevance: level, reasons: [{ code: "match-symbol", ref: e.ref, detail: constraint.match.symbols.join(", ") }], matched: e.id, field: "match.symbols" };
    }
  }
  const task = scope.taskText.toLowerCase();
  const first = scope.entries[0];
  const word = constraint.match.keywords.find((w) => w.length > 0 && task.includes(w.toLowerCase()));
  if (word !== undefined && first !== undefined) {
    return { relevance: "related", reasons: [{ code: "match-keyword", ref: "task", detail: word }], matched: first.id, field: "match.keywords" };
  }
  return { relevance: "none", reasons: [{ code: "not-in-context", ref: constraint.id }] };
}

function activeGoverning(truth: Pick<ProjectTruth, "decisions">, requirementId: string, scope: RelevanceScope): string | undefined {
  const inScope = new Set(scope.entries.filter((e) => e.type === "decision" && e.hops !== undefined).map((e) => e.ref));
  return truth.decisions.find((d) => d.state === "confirmed" && d.supersededBy === null && inScope.has(d.id) && d.governs.requirements.includes(requirementId))?.id;
}

/**
 * A declared gap concerns the task through its owner:
 * - direct: the owner is a task seed, a Requirement or Decision one edge from a seed, or a
 *   Requirement in the context that an active Decision in the context governs;
 * - related: the owner is elsewhere in the context (further away, an Issue or Milestone, or a
 *   candidate that did not fit the budget), or a project-scoped gap shares a search term with the task;
 * - none: otherwise. Project-scoped gaps are never direct.
 */
export function matchDeclaredGap(gap: DeclaredGap, scope: RelevanceScope, truth: Pick<ProjectTruth, "decisions">): RelevanceResult {
  if (gap.owner.type === "project") {
    const task = new Set(searchTerms(scope.taskText));
    const shared = [...new Set(searchTerms(gap.text).filter((t) => task.has(t)))];
    return shared.length > 0
      ? { relevance: "related", reasons: [{ code: "project-scope" }, { code: "keyword-overlap", ref: "task", detail: shared.join(", ") }] }
      : { relevance: "none", reasons: [{ code: "project-scope" }] };
  }
  const ownerId = gap.owner.id;
  const entry = scope.entries.find((e) => e.type === gap.owner.type && e.ref === ownerId);
  if (entry === undefined) return { relevance: "none", reasons: [{ code: "not-in-context", ref: ownerId }] };
  if (entry.seed) return { relevance: "direct", reasons: [{ code: "task-seed", ref: ownerId }], matched: entry.id };
  if (entry.hops !== undefined && entry.hops <= 1 && (entry.type === "requirement" || entry.type === "decision")) {
    return { relevance: "direct", reasons: [{ code: "near-intent", ref: ownerId, detail: "1 edge from a seed" }], matched: entry.id };
  }
  if (entry.type === "requirement" && entry.hops !== undefined) {
    const d = activeGoverning(truth, ownerId, scope);
    if (d !== undefined) return { relevance: "direct", reasons: [{ code: "governed-by-active-decision", ref: d, detail: ownerId }], matched: entry.id };
  }
  return { relevance: "related", reasons: [{ code: "in-context", ref: ownerId, detail: entry.hops === undefined ? "omitted by budget" : `${entry.hops} edges from a seed` }], matched: entry.id };
}
