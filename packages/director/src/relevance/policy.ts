/**
 * Intent relevance policy (T10.1): one deterministic answer to "does this piece of intent concern
 * the current task?", shared by the Context Compiler (Constraint selection), Knowledge Gap
 * assessment (declared gaps) and, later, Review. No score: direct, related or none, always with
 * the reasons that decided it, so a later consumer can cite the same evidence.
 *
 * The scope is the task's candidate context as an ordered list: the Compiler passes its ranked
 * traversal candidates, Gap assessment passes the Packet's items and omitted candidates.
 */
import { compileRepoPattern, normalizeGapText, type Constraint, type DeclaredGap, type EntityType, type ProjectTruth, type RepoPath } from "@duo-director/core";
import type { SeedProvenance } from "../context/types.js";
import { searchTerms } from "./terms.js";

export const RELEVANCE_POLICY_VERSION = "2";

export type Relevance = "direct" | "related" | "none";

export type RelevanceReasonCode =
  | "task-seed" | "near-intent" | "governed-by-active-decision" | "in-context" | "gap-mentioned" | "retrieved-seed"
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
  /** Set when the entry is itself a seed. */
  readonly seed?: SeedProvenance;
  /** Provenance of the seed its best path starts from, and that seed's reference. */
  readonly origin?: SeedProvenance;
  readonly originRef?: string;
  /** Symbols and files. */
  readonly path?: string;
  readonly qualifiedName?: string;
}

export interface RelevanceScope {
  /** In rank order: the first matching entry is the evidence. */
  readonly entries: readonly ScopeEntry[];
  readonly taskText: string;
}

/** Symbol-name pattern of match.symbols / forbids.symbols: "*" any text, "?" one character. */
export function wildcard(pattern: string): RegExp {
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

const KEY_TOKENS = /[^a-z0-9_.-]+/u;
const MIN_MENTION_CHARS = 4;

/** The task names the gap itself: its key as a token, or its whole normalized text. */
function gapMention(gap: DeclaredGap, task: string): RelevanceReason | undefined {
  if (gap.key !== undefined && task.toLowerCase().split(KEY_TOKENS).includes(gap.key.toLowerCase())) {
    return { code: "gap-mentioned", ref: gap.id, detail: `key ${gap.key}` };
  }
  const text = normalizeGapText(gap.text);
  if ([...text].length >= MIN_MENTION_CHARS && normalizeGapText(task).includes(text)) return { code: "gap-mentioned", ref: gap.id, detail: "text" };
  return undefined;
}

/**
 * A declared gap concerns the task through an explicit link (T11.1):
 * - direct: the task mentions the gap itself (key or whole text; any owner, project included), or
 *   the owner is an explicit seed, a Requirement or Decision one edge from an explicit seed, or a
 *   Requirement reached from an explicit seed that an active Decision in the context governs;
 * - related: the owner is only a retrieved (keyword) seed or reached from one, or elsewhere in the
 *   context (further away, an Issue or Milestone, omitted by budget), or a project-scoped gap
 *   shares a search term with the task;
 * - none: otherwise.
 * Retrieval finds context; it never alone makes a gap direct (never alone a human question).
 */
export function matchDeclaredGap(gap: DeclaredGap, scope: RelevanceScope, truth: Pick<ProjectTruth, "decisions">): RelevanceResult {
  const mention = gapMention(gap, scope.taskText);
  if (mention !== undefined) return { relevance: "direct", reasons: [mention] };
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
  if (entry.seed === "explicit") return { relevance: "direct", reasons: [{ code: "task-seed", ref: ownerId }], matched: entry.id };
  if (entry.seed === "retrieved") return { relevance: "related", reasons: [{ code: "retrieved-seed", ref: ownerId, detail: "keyword seed" }], matched: entry.id };
  if (entry.hops !== undefined && entry.origin === "retrieved") {
    return { relevance: "related", reasons: [{ code: "retrieved-seed", ref: entry.originRef ?? ownerId, detail: `reached from a keyword seed, ${entry.hops} edges` }], matched: entry.id };
  }
  if (entry.hops !== undefined && entry.hops <= 1 && (entry.type === "requirement" || entry.type === "decision")) {
    return { relevance: "direct", reasons: [{ code: "near-intent", ref: ownerId, detail: "1 edge from a seed" }], matched: entry.id };
  }
  if (entry.type === "requirement" && entry.hops !== undefined) {
    const d = activeGoverning(truth, ownerId, scope);
    if (d !== undefined) return { relevance: "direct", reasons: [{ code: "governed-by-active-decision", ref: d, detail: ownerId }], matched: entry.id };
  }
  return { relevance: "related", reasons: [{ code: "in-context", ref: ownerId, detail: entry.hops === undefined ? "omitted by budget" : `${entry.hops} edges from a seed` }], matched: entry.id };
}
