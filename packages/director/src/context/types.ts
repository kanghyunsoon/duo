/**
 * Context Compiler domain model (TASK-010). The Packet is machine-readable first: CLI, MCP and UI
 * read this structure; the Markdown renderer (render.ts) only formats it. Scores never appear:
 * rank is an order (04). Nothing time-dependent is in a Packet, so the same input gives the same
 * bytes (REQ-NFR-005).
 */
import type { Diagnostic, SourceLocation } from "@duo-director/core";
import type { GraphEdgeType } from "@duo-director/graph";
import type { TextMeasure, TokenEstimatorName } from "../tokens/index.js";

/** MVP has one profile. It is part of the request and of the Packet Dependency Digest. */
export type ContextProfile = "default";

export interface ContextRequest {
  /** Free text or a known ID ("AUTH-03", "GAME-42 refresh token", "D-004"). Search input only: never a shell, path or SQL fragment. */
  readonly task: string;
  /** Token budget (o200k_base). Default: project.yaml context.default_budget_tokens (6000). */
  readonly budget?: number;
  readonly profile?: ContextProfile;
}

export type ContextStatus = "ready" | "index-required" | "ambiguous" | "insufficient-context";

/** How a seed was found (05 Seed 해석). */
export type SeedMatch = "id" | "path" | "symbol" | "symbol-name" | "keyword";

export interface ContextSeed {
  /** Node ID. */
  readonly id: string;
  /** Display reference: "AUTH-03", "src/a.ts", "src/a.ts#A.b". */
  readonly ref: string;
  readonly match: SeedMatch;
  /** The task term that matched. */
  readonly term: string;
}

export interface SeedOption {
  readonly id: string;
  readonly ref: string;
  readonly kind: string;
  readonly title?: string;
}

export interface SeedAmbiguity {
  readonly term: string;
  readonly reason: "symbol-name" | "qualified-name" | "keyword-tie";
  readonly options: readonly SeedOption[];
}

export interface SeedResolution {
  readonly seeds: readonly ContextSeed[];
  readonly ambiguities: readonly SeedAmbiguity[];
  /** Definition IDs written in the task that are not in the Project Graph. */
  readonly unresolvedIds: readonly string[];
}

/** Structured signals for TASK-011 (Knowledge Gap). The Compiler reports them; it asks nothing. */
export type KnowledgeSignal =
  | { readonly kind: "no-seed" }
  | { readonly kind: "unresolved-id"; readonly ids: readonly string[] }
  | { readonly kind: "no-confirmed-intent" }
  | { readonly kind: "unconfirmed-decision"; readonly ids: readonly string[] };

export type Representation = "L1" | "L2" | "L3";

/** Packing tiers in budget priority order (05, 09): intent > decision > direct code > tests > issues > structural > historical. */
export type ContextTier = "requirement" | "decision" | "pending" | "code-direct" | "test" | "issue" | "code-structural" | "code-historical";

/** One edge on the path that brought a candidate in (the best-ranked path from a seed). */
export interface EvidenceStep {
  readonly from: string;
  readonly type: GraphEdgeType | "SUPERSEDED_BY" | "MATCHES";
  readonly to: string;
  /** Edge provenance (declared, static, git) or, for constraint matches, the matching field. */
  readonly provenance: string;
}

export interface PacketItem {
  readonly id: string;
  readonly ref: string;
  readonly kind: "requirement" | "decision" | "constraint" | "issue" | "milestone" | "file" | "symbol" | "test";
  /** 1-based position in the ranked candidate list. An order, not a score. */
  readonly rank: number;
  readonly tier: ContextTier;
  readonly level: Representation;
  /** Rendered text of this item at its level, secrets redacted. */
  readonly text: string;
  /** o200k_base tokens of the item and its evidence line as rendered. */
  readonly tokens: number;
  readonly source?: SourceLocation;
  /** Seed (empty path) or the edges from a seed. */
  readonly via: { readonly seed: string; readonly steps: readonly EvidenceStep[] };
  /** Decisions and constraints: state as written in Project Truth. */
  readonly state?: string;
}

export interface DecisionHistoryItem {
  readonly id: string;
  readonly title: string;
  readonly state: "superseded";
  readonly supersededBy: string | null;
}

/** A proposal or unconfirmed Decision. Never Project Truth, never an instruction (T09.1). */
export interface PendingDecisionItem {
  readonly id: string;
  readonly kind: "proposal" | "decision" | "constraint";
  readonly title: string;
  readonly confirmed: false;
  readonly status: "PENDING / NOT CONFIRMED";
  /** True when the pending choice concerns a seed or supersedes an active Decision in this Packet. */
  readonly requiresHumanDecision: boolean;
  /** IDs in this Packet the proposal refers to. */
  readonly relatesTo: readonly string[];
  readonly level: "L1" | "L2";
  readonly text: string;
  readonly tokens: number;
  readonly source?: SourceLocation;
}

export interface OmittedCandidate {
  readonly id: string;
  readonly ref: string;
  readonly rank: number;
  readonly tier: ContextTier;
  readonly reason: "budget";
}

export interface ContextLimitation {
  readonly code: string;
  readonly message: string;
}

export interface PacketBudget {
  readonly total: number;
  /** Frame: header, task, section headings, limitations. */
  readonly reserved: number;
  /** Tokens of the rendered Markdown Packet (the text an agent receives). */
  readonly used: number;
  readonly remaining: number;
}

export interface PacketMetrics {
  readonly estimator: TokenEstimatorName;
  readonly budget: PacketBudget;
  readonly candidates: number;
  readonly selected: number;
  readonly omitted: number;
  /** Tokens of every candidate at its fullest representation. */
  readonly candidateTokens: number;
  /** = budget.used. */
  readonly selectedTokens: number;
  /** The rendered Packet's sizes (AC-010-06). */
  readonly rendered: TextMeasure;
  readonly redactions: number;
  readonly llmCalls: 0;
}

export interface ContextPacket {
  readonly format: "duo.context-packet/1";
  readonly request: { readonly task: string; readonly taskTruncated: boolean; readonly budget: number; readonly profile: ContextProfile };
  readonly seeds: readonly ContextSeed[];
  readonly intent: { readonly requirements: readonly PacketItem[]; readonly constraints: readonly PacketItem[] };
  readonly decisions: { readonly active: readonly PacketItem[]; readonly history: readonly DecisionHistoryItem[] };
  readonly code: readonly PacketItem[];
  readonly tests: readonly PacketItem[];
  readonly issues: readonly PacketItem[];
  readonly pendingDecisions: readonly PendingDecisionItem[];
  /** Why each included item is here: its path from a seed (graph edges and their provenance). */
  readonly evidence: readonly { readonly id: string; readonly ref: string; readonly via: PacketItem["via"] }[];
  readonly limitations: readonly ContextLimitation[];
  readonly signals: readonly KnowledgeSignal[];
  readonly omittedCandidates: readonly OmittedCandidate[];
  readonly truncated: boolean;
  readonly requiresHumanDecision: boolean;
  readonly metrics: PacketMetrics;
  /** sha256 over everything the Packet was derived from (05 Packet Dependency Digest). */
  readonly dependencyDigest: string;
}

/** Request-level measurements. Repository-wide values live here, outside the Packet, so they do not invalidate Packet caches. */
export interface ContextMetrics {
  readonly estimator: TokenEstimatorName;
  readonly repository: { readonly files: number; readonly tokens: number; readonly bytes: number; readonly chars: number; readonly binaryFiles: number };
  readonly filesConsidered: number;
  /** Whole files the candidates live in: the cost of an agent that reads related files entirely (09). */
  readonly rawCandidateTokens: number;
  readonly candidateTokens: number;
  readonly selectedTokens: number;
  readonly budget: number;
  readonly filesLoaded: number;
  /** (1 − selected / x) × 100, two decimals; null when x is 0. */
  readonly reduction: { readonly vsRepository: number | null; readonly vsRawCandidates: number | null };
  readonly llmCalls: 0;
}

/** Wall-clock milliseconds per stage. Varies between runs; never part of a Packet. */
export interface ContextPerformance {
  readonly freshnessMs: number;
  readonly seedMs: number;
  readonly traversalMs: number;
  readonly rankingMs: number;
  readonly retrievalMs: number;
  readonly tokenizationMs: number;
  readonly packingMs: number;
  readonly metricsMs: number;
  readonly totalMs: number;
}

export interface ContextResult {
  readonly status: ContextStatus;
  readonly packet?: ContextPacket;
  readonly resolution?: SeedResolution;
  readonly freshness: { readonly status: "current" | "stale" | "missing" | "incompatible"; readonly fullRebuildRequired: boolean };
  readonly signals: readonly KnowledgeSignal[];
  readonly metrics?: ContextMetrics;
  readonly cache: { readonly status: "off" | "hit" | "miss"; readonly written: boolean };
  readonly performance: ContextPerformance;
  readonly diagnostics: readonly Diagnostic[];
}
