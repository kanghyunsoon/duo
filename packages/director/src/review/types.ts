/**
 * Review domain model (TASK-013). A Review answers one question: do these changes agree with the
 * Project Intent, Requirements and Decisions a human confirmed? It observes and judges; it never
 * edits code or Project Truth, confirms a Decision, commits or runs tests.
 *
 * Claim → Evidence → Verdict: every claim cites evidence IDs, alignment is ALIGNED / PARTIAL /
 * CONFLICT / UNKNOWN (no score), and the Review verdict is PASS / WARN / BLOCK / ASK (ADR-007).
 * PASS means DUO found no direction conflict within the evidence it had, not that the code is
 * free of bugs.
 */
import type { GitDiffEnd } from "@duo-director/analyzer";
import type { DecisionState, Diagnostic, EntityRef, Evidence, EvidenceBasis, RepoPath } from "@duo-director/core";
import type { IndexStatus } from "@duo-director/graph";
import type { KnowledgeGapAssessment } from "../gap/types.js";
import type { LLMFailureCategory } from "../llm/contract/types.js";
import type { ViolationProvenance } from "../adoption/types.js";

export interface TestRunEvidence {
  readonly command?: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly tests?: readonly { readonly path?: RepoPath; readonly name: string; readonly status: "passed" | "failed" | "skipped" }[];
}

export interface ReviewRequest {
  readonly task?: string;
  /** No default: the caller (CLI) decides the endpoints. */
  readonly diff: { readonly from: GitDiffEnd; readonly to: GitDiffEnd; readonly files?: readonly RepoPath[] };
  readonly budget?: number;
  readonly includeSemanticAssist?: boolean;
  /** Results of a test run the caller performed. */
  readonly testResults?: TestRunEvidence;
}

export type ReviewRule =
  | "decision-integrity" | "supersede-integrity" | "decision-forbids" | "decision-governance" | "declared-reference"
  | "requirement-implementation" | "constraint-compliance" | "scope-relevance" | "test-coverage" | "test-result"
  | "unlinked-addition" | "external-source-drift" | "decision-forbids-import";

/**
 * What was asked, as recorded (T13.1). identity = sha256 of the semantic input that shapes the
 * deterministic result: task, diff endpoints and file filter, budget, caller test results.
 * includeSemanticAssist is not part of it (semantic assistance never changes the deterministic result).
 */
export interface ReviewRequestIdentity {
  readonly identity: string;
  readonly task: string;
  readonly from: string;
  readonly to: string;
  readonly files?: readonly RepoPath[];
  readonly budget?: number;
  /** sha256 of the caller-supplied test results. */
  readonly testRun?: string;
}

export type Alignment = "ALIGNED" | "PARTIAL" | "CONFLICT" | "UNKNOWN";
export type Verdict = "PASS" | "WARN" | "BLOCK" | "ASK";

export interface ReviewClaim {
  /** "claim-" + hash(rule, subject, discriminator, diff identity). */
  readonly id: string;
  readonly rule: ReviewRule;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly expected: string;
  readonly observed: string;
  readonly alignment: Alignment;
  /** At least one (AC-013-02), ID order. */
  readonly evidenceIds: readonly string[];
  /** Union of the cited evidence's bases, sorted. */
  readonly basis: readonly EvidenceBasis[];
  /** Short structured reason code, e.g. "lock-digest-mismatch". */
  readonly reason: string;
  /** The rule is enforced (a block-enforced Decision, the lock of a confirmed Decision). */
  readonly enforced: boolean;
  /** CONFLICT, enforced, and Project Truth plus observable evidence (blockEligible policy). */
  readonly blockEligible: boolean;
  /** An UNKNOWN that is a meaningful drift signal (counts toward WARN). */
  readonly drift: boolean;
  /** Needs a semantic judgement DUO cannot make deterministically. */
  readonly semanticCandidate: boolean;
  /** Baseline rules (decision-forbids, declared-reference, external-source-drift): stable identity, no diff or line (T14.1). */
  readonly violationKey?: string;
  /** Relative to the Adoption Baseline; absent without a usable baseline or for ALIGNED claims. */
  readonly provenance?: ViolationProvenance;
  /**
   * C241 (T49): lifecycle facts of the Decision this claim is about, read from the complete Project Truth the rules used.
   * Present only for a deterministic claim whose subject is a Decision found in that Truth. Explanation only: it is set
   * after the verdict, is not part of the claim ID and is not written to a Review Record.
   */
  readonly decisionAuthority?: DecisionAuthority;
}

/**
 * The Decision's own lifecycle fields as Project Truth has them (C241). active is the rules' authority test
 * (confirmed and not superseded). supersedes and supersededBy are the direct relations only, never a resolved chain,
 * and are shown as written even when they disagree with the other Decision (supersede-integrity judges that).
 */
export interface DecisionAuthority {
  readonly state: DecisionState;
  readonly active: boolean;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
}

export interface ChangedHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly evidenceId: string;
}

export interface ChangedFile {
  readonly path: RepoPath;
  readonly oldPath?: RepoPath;
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "untracked";
  readonly similarity?: number;
  readonly binary: boolean;
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly hunks: readonly ChangedHunk[];
  /** Hunk evidence, or one change record when there are no hunks. */
  readonly evidenceIds: readonly string[];
  /**
   * adoption-bootstrap (T15.1): a Project Truth file exactly as init wrote it (Adoption Baseline
   * bootstrapTruth, not committed yet). Shown, but not reviewed: no seed, no rule, no gap.
   */
  readonly provenance?: "adoption-bootstrap";
}

export interface DiffSeed {
  readonly id: string;
  readonly ref: string;
  readonly entity: EntityRef;
  /** hunk-overlap: a hunk touches its current range (overlap, not ownership). */
  readonly reason: "hunk-overlap" | "file-changed" | "truth-changed";
  readonly path: RepoPath;
  readonly evidenceIds: readonly string[];
}

export interface ReviewLimitation {
  readonly code: string;
  readonly message: string;
}

export interface SemanticClaim {
  readonly claimId: string;
  readonly alignment: Alignment;
  readonly evidenceIds: readonly string[];
  readonly basis: readonly EvidenceBasis[];
  readonly reason: string;
  /** Always false: LLM output never blocks. */
  readonly blockEligible: false;
}

export interface SemanticAssist {
  readonly status: "not-requested" | "no-candidates" | "disabled" | "unavailable" | "failed" | "call-cap" | "success";
  readonly failure?: LLMFailureCategory;
  /** The provider that answered or failed: id, reported model, cache identity. Never a secret. */
  readonly provider?: { readonly id: string; readonly model?: string; readonly cacheIdentity?: string };
  readonly candidates: readonly string[];
  /** Semantic candidates that stay UNKNOWN because no semantic check ran (AC-013-03). */
  readonly skippedChecks: readonly { readonly claimId: string; readonly rule: ReviewRule; readonly reason: string }[];
  readonly claims: readonly SemanticClaim[];
  readonly evidence: readonly Evidence[];
  /** The deterministic verdict, raised to WARN at most by semantic PARTIAL / CONFLICT. */
  readonly verdict?: Verdict;
  readonly calls: number;
  readonly cacheHits: number;
  /** Token usage the provider reported for a call made now (T12B); absent for a cache hit or no call. Never estimated. */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number };
}

export interface ReviewMetrics {
  readonly changedFiles: number;
  readonly changedHunks: number;
  readonly diffSeeds: number;
  readonly claims: Readonly<Record<Alignment, number>>;
  readonly evidence: Readonly<Record<EvidenceBasis, number>>;
  readonly contextTokens: number;
  readonly taskContextTokens: number;
  readonly semanticCandidates: number;
  readonly llmCalls: number;
  readonly llmCacheHits: number;
}

export interface ReviewResult {
  readonly format: "duo.review/1";
  readonly status: "ready" | "index-required";
  readonly request: ReviewRequestIdentity;
  /** The Adoption Baseline the provenance was judged against (T14.1). */
  readonly baseline: { readonly status: "missing" | "present" | "incompatible"; readonly id?: string };
  readonly freshness: { readonly status: IndexStatus; readonly fullRebuildRequired: boolean };
  readonly diff?: { readonly identity: string; readonly from: string; readonly to: string; readonly files: readonly ChangedFile[] };
  readonly seeds: readonly DiffSeed[];
  /** Deterministic verdict. Semantic assistance never changes it. */
  readonly verdict?: Verdict;
  readonly verdictBasis: { readonly blocking: readonly string[]; readonly ask: readonly string[]; readonly warn: readonly string[] };
  readonly claims: readonly ReviewClaim[];
  readonly evidence: readonly Evidence[];
  readonly gaps?: KnowledgeGapAssessment;
  readonly context?: { readonly review?: string; readonly task?: string; readonly profile: "review"; readonly seeds: readonly string[] };
  readonly limitations: readonly ReviewLimitation[];
  readonly semanticAssist: SemanticAssist;
  readonly metrics: ReviewMetrics;
  readonly diagnostics: readonly Diagnostic[];
}

/** Wall clock, kept out of ReviewResult so the deterministic body stays byte-identical. */
export interface ReviewPerformance {
  readonly totalMs: number;
  /** Read-only index inspection (TASK-019: measured separately from the diff). */
  readonly freshnessMs: number;
  readonly diffMs: number;
  readonly contextMs: number;
  /** Knowledge Gap assessment of the review context. */
  readonly gapMs: number;
  readonly rulesMs: number;
  readonly semanticMs: number;
}
