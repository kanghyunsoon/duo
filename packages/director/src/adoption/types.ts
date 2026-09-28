/**
 * Existing Project Adoption (T14.1). The Adoption Baseline records the repository state at the moment
 * DUO started to manage the project: provenance to tell "existed before DUO" from "changed after DUO".
 * It does not say the existing code is right, matches Human Intent, or that its debt is approved.
 *
 *   init apply → Truth → initial index → index current → captureAdoptionBaseline()
 *
 * Capture is a separate, explicit human action (never inside applyInitPlan, never implicit). The
 * record is tracked human-approved history: .duo-project/reviews/adoption-<16 hex>.json.
 */
import type { RepoPath } from "@duo-director/core";

/**
 * HEAD_BASELINE: the baseline commit is HEAD; staged, unstaged and untracked changes stay changes to
 * review after adoption. ABORT_AND_CLEAN: capture nothing; the human commits or stashes first.
 * (Adopting the dirty working tree itself as a snapshot is not supported in the MVP.)
 */
export type DirtyAdoptionPolicy = "HEAD_BASELINE" | "ABORT_AND_CLEAN";

/** Working tree changes outside .duo-project (DUO's own Truth is covered by the Truth digest). */
export interface WorkingTreeObservation {
  readonly dirty: boolean;
  readonly staged: readonly RepoPath[];
  readonly unstaged: readonly RepoPath[];
  readonly untracked: readonly RepoPath[];
  readonly conflicted: readonly RepoPath[];
  /** Counts before any list cap. */
  readonly counts: { readonly staged: number; readonly unstaged: number; readonly untracked: number; readonly conflicted: number };
  /** Changed secret files (.env, keys, …) are counted, never listed or read. */
  readonly excludedSecrets: number;
  readonly truncated: boolean;
}

export type BaselineRule = "decision-forbids" | "declared-reference" | "external-source-drift";

/** A deterministic finding that already held at adoption. */
export interface BaselineFinding {
  /** violationKey(rule, governing, offending). */
  readonly key: string;
  readonly rule: BaselineRule;
  /** The Truth entity whose rule is violated (Decision, Requirement, Constraint ID or Vision path). */
  readonly governing: string;
  /** What violates it: a node ID, "dep:<manifest>#<name>", "ref:<field>:<name>" or "src:<path>#<section>". */
  readonly offending: string;
  readonly path?: RepoPath;
  /** decision-forbids: the Decision is enforcement: block. */
  readonly enforced?: boolean;
}

/** Where a violation found by Review comes from, relative to the Adoption Baseline. */
export type ViolationProvenance = "introduced" | "pre-existing" | "pre-existing-touched";

export interface AdoptionBaselineBody {
  /** /2 (T15.1): findings evaluated on the HEAD tree, bootstrapTruth. A /1 record is incompatible (not reinterpreted). */
  readonly format: "duo.adoption-baseline/2";
  readonly project: { readonly name: string; readonly rootCommits: readonly string[] };
  readonly git: { readonly headOid: string; readonly branch?: string; readonly detached: boolean };
  readonly truth: { readonly digest: string };
  readonly index: { readonly graphSchemaVersion: number; readonly stateToken: string };
  readonly workingTree: {
    readonly dirty: boolean;
    readonly policy: "HEAD_BASELINE";
    readonly staged: readonly { readonly path: RepoPath; readonly indexBlob?: string }[];
    readonly unstaged: readonly { readonly path: RepoPath; readonly contentHash?: string }[];
    readonly untracked: readonly { readonly path: RepoPath; readonly contentHash?: string }[];
    readonly conflicted: readonly RepoPath[];
    readonly counts: WorkingTreeObservation["counts"];
    readonly excludedSecrets: number;
    readonly truncated: boolean;
  };
  /**
   * Project Truth files init left uncommitted (untracked or changed against HEAD at capture): path and
   * sha256 of the canonical text. Review classifies an identical file as adoption-bootstrap (T15.1).
   */
  readonly bootstrapTruth: readonly { readonly path: RepoPath; readonly contentHash: string }[];
  /** The state the findings describe: always the HEAD tree (HEAD_BASELINE). */
  readonly findingsAt: "HEAD";
  /** Ordered by key. */
  readonly findings: readonly BaselineFinding[];
  readonly limitations: readonly string[];
}

export interface AdoptionBaselineRecord extends AdoptionBaselineBody {
  readonly id: string;
  readonly recorded: { readonly by: string; readonly at: string };
}

/**
 * missing: no baseline (e.g. a project initialized before T14.1; capture is explicit).
 * current: HEAD is the baseline commit. advanced: the baseline commit is in HEAD's history.
 * repository-diverged: the baseline commit is not in the (reachable) history or the repository differs.
 * incompatible: the record is unreadable, tampered, of another format, or there is more than one.
 */
export type AdoptionBaselineStatus = "missing" | "current" | "advanced" | "repository-diverged" | "incompatible";

export interface AdoptionBaselineState {
  readonly status: AdoptionBaselineStatus;
  readonly id?: string;
  readonly path?: RepoPath;
  readonly baseline?: AdoptionBaselineRecord;
  readonly reason?: string;
}

export type CaptureResult =
  | { readonly status: "captured" | "unchanged"; readonly id: string; readonly path: RepoPath; readonly baseline: AdoptionBaselineRecord; readonly workingTree: WorkingTreeObservation }
  | { readonly status: "aborted"; readonly reason: "dirty-working-tree"; readonly workingTree: WorkingTreeObservation };
