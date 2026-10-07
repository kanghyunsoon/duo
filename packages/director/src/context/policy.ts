/**
 * Context Compiler policy (TASK-010, documented in docs/05-context-compiler.md). Numbers order
 * candidates; they are not relevance claims and never leave the Compiler. Any change to selection,
 * representation or rendering bumps CONTEXT_POLICY_VERSION, which is part of the Packet
 * Dependency Digest, so old cached Packets stop matching.
 */
import type { GraphEdgeType } from "@duo-director/graph";
import type { ContextTier } from "./types.js";

/**
 * 2: T18.0, generic-file head window, capability limitations, cross-language factor, Python comment lines as leading context.
 * T24.1 (C217, C225) kept 2: it changed only the level texts of Symbols with more than one location, and those texts'
 * hashes are already in the Packet Dependency Digest; a bump would change the digest of every other Packet too.
 * 3: H-76 (T42, F-23): explicit primary seeds (a Requirement or Issue named by exact ID) take their highest fitting
 * representation before normal promotion; the selection changes, so old cached Packets must stop matching.
 * 4: C249 (T46): an exact path token is not reused as BM25 keyword input (a task token that resolved to an existing File).
 */
export const CONTEXT_POLICY_VERSION = "4";

/** Per-hop multiplier. A candidate's order value is seed strength × Π hop weights (best path). */
export const EDGE_WEIGHTS: Readonly<Record<Exclude<GraphEdgeType, "SUPERSEDES">, number>> = {
  GOVERNS: 1.0,
  IMPLEMENTS: 0.9,
  TRACKED_BY: 0.9,
  VALIDATED_BY: 0.8,
  REQUIRES: 0.7,
  CALLS: 0.7,
  CONTAINS: 0.6,
  IMPORTS: 0.5,
  CHANGED_WITH: 0.3,
};

/** Seed strengths (05). Keyword seeds are normalized to the best keyword score, then scaled. */
export const SEED_STRENGTH = { id: 1.0, path: 1.0, symbol: 1.0, "symbol-name": 0.9, keyword: 0.6, diff: 1.0 } as const;

/**
 * T18.0: a code candidate (file, symbol, test) in another language family than the code seed that
 * brought it in ranks at this fraction of its order value. The same Requirement implemented in another
 * language stays in the Packet, after the seed language's own code. TypeScript, TSX and JavaScript are
 * one family; a Truth seed or a file without a structural analyzer has no language and no factor.
 */
export const CROSS_LANGUAGE_FACTOR = 0.5;

export const DEFAULT_LIMITS = {
  /** Upper bound; project.yaml context.max_depth (1–3, default 2) replaces it. */
  maxDepth: 2,
  /** Finalized candidates (05 nodeLimit 200). */
  nodeLimit: 200,
  /** Edges read per expanded node. */
  edgeLimit: 2000,
} as const;

export const MIN_BUDGET = 1000;
export const MAX_BUDGET = 1_000_000;
/** The task text is quoted up to this many tokens (05). */
export const TASK_TOKEN_LIMIT = 200;

export const KEYWORD = {
  /** Keyword seeds kept (05: top 8). */
  top: 8,
  /** Keyword matches below this fraction of the best one are not seeds. */
  minFraction: 0.3,
  /** BM25 parameters. */
  k1: 1.2,
  b: 0.75,
} as const;

/** A symbol name that matches more symbols than this is too generic to be a seed or an ambiguity. */
export const SYMBOL_NAME_MAX_MATCHES = 5;

/**
 * Packing order. Floors (L1) are placed in this order; promotions run in this order, first with a
 * share cap of the promotion budget per tier, then without caps (diversity without an optimizer).
 */
export const TIER_ORDER: readonly ContextTier[] = [
  "requirement", "decision", "pending", "code-direct", "test", "issue", "code-structural", "code-historical",
];

export const TIER_SHARE: Readonly<Record<ContextTier, number>> = {
  requirement: 0.25,
  decision: 0.15,
  pending: 0.05,
  "code-direct": 0.3,
  test: 0.12,
  issue: 0.05,
  "code-structural": 0.06,
  "code-historical": 0.02,
};

/** In the capped pass, at most this many L3 items from one file (the rest wait for the uncapped pass). */
export const L3_PER_FILE_FIRST_PASS = 2;

/** Lines of comments and decorators kept directly above a symbol or test (surrounding context). */
export const LEADING_CONTEXT_LINES = 12;

/**
 * A file no structural analyzer reads (T18.0) has no symbol ranges: its L2 is its first lines, never
 * the whole file. Both bounds apply; the window ends at the last whole line that fits.
 */
export const GENERIC_FILE_WINDOW = { lines: 40, chars: 2000 } as const;
