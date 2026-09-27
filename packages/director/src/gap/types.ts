/**
 * Knowledge Gap domain model (TASK-011). A gap is something still undecided that matters for the
 * current task. Two sources, never mixed: declared gaps a human wrote in Project Truth
 * ("UNKNOWN: …") and runtime gaps DUO finds while assessing this task (ambiguous or missing
 * target, missing intent, pending decision). Neither is a Graph node or a stored file.
 */
import type { EntityRef, SourceLocation } from "@duo-director/core";
import type { RelevanceReasonCode } from "../relevance/index.js";
import type { SeedOption } from "../context/types.js";

export type GapSource = "declared" | "runtime";
export type GapKind = "declared" | "ambiguous-target" | "unresolved-target" | "missing-intent" | "pending-decision";
export type GapRelevance = "direct" | "related" | "none";
export type GapAction = "ask" | "surface" | "ignore";

export type GapReasonCode =
  | RelevanceReasonCode
  | "ambiguous-seed" | "unresolved-id" | "no-seed" | "no-confirmed-intent"
  | "requires-human-decision" | "pending-related" | "resolved-by-decision" | "no-resolution";

export interface GapReason {
  readonly code: GapReasonCode;
  readonly ref?: string;
  readonly detail?: string;
}

export interface KnowledgeGap {
  /** Declared: "gap-" + hash(owner, key, text). Runtime: "rgap-" + hash(kind, task, anchors). */
  readonly id: string;
  readonly source: GapSource;
  readonly kind: GapKind;
  /** What is unknown, as data (no question wording: see render.ts). */
  readonly text: string;
  readonly anchors: readonly EntityRef[];
  readonly location?: SourceLocation;
  readonly relevance: GapRelevance;
  readonly reasons: readonly GapReason[];
  readonly action: GapAction;
  /** Declared gaps: question key of "UNKNOWN(key): …". */
  readonly key?: string;
  /** Declared gaps: resolved means an active Decision answers the key for the owner. */
  readonly resolution?: { readonly status: "resolved"; readonly decision: string } | { readonly status: "unresolved" };
  /** ambiguous-target: the task term and the candidates DUO could not choose between. */
  readonly term?: string;
  readonly options?: readonly SeedOption[];
  /** unresolved-target: the ID written in the task. */
  readonly target?: string;
  /** pending-decision: the proposal or unconfirmed Decision (never confirmed intent). */
  readonly pending?: { readonly id: string; readonly title: string; readonly relatesTo: readonly string[] };
}

export interface GapMetrics {
  readonly declaredConsidered: number;
  readonly runtime: number;
  readonly direct: number;
  readonly related: number;
  readonly none: number;
  readonly ask: number;
  readonly surface: number;
  readonly ignore: number;
  readonly llmCalls: 0;
}

export interface KnowledgeGapAssessment {
  readonly format: "duo.gap-assessment/1";
  /** index-required: the Context was not built on a current index, so nothing is judged. */
  readonly status: "assessed" | "index-required";
  /** Ordered: ask (by priority), surface, ignore. */
  readonly gaps: readonly KnowledgeGap[];
  /** True only when the task cannot go on without a human choice (some gap is "ask"). */
  readonly requiresHumanInput: boolean;
  /** The ask gap to put to the human first; its answer may settle the others. */
  readonly primary?: string;
  /** The remaining ask gaps, in priority order. */
  readonly additional: readonly string[];
  /** DUO analysis limits (unresolved calls, …): evidence limitations, never human questions. */
  readonly technicalLimitations: readonly string[];
  readonly metrics: GapMetrics;
}
