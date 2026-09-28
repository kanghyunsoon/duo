/**
 * Adoption Baseline capture and read model (T14.1). Capture is an explicit human action after init
 * and a current index; it is never run by applyInitPlan() or by a read. One baseline per project: the
 * same state captured again is a no-op, a different one is refused (a later capture would turn
 * introduced violations into "pre-existing"). Reading never writes, repairs or recaptures.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openGitProvider, type AnalyzerRegistry } from "@duo-director/analyzer";
import {
  compareUtf8, createDiagnostic, failure, loadProjectTruth, success, truthDigest,
  type DecisionActor, type ParseResult, type RepoPath,
} from "@duo-director/core";
import { inspectIndex, readIndexState, type GraphReader, type IndexedGraph } from "@duo-director/graph";
import { ADOPTION_BASELINE_FORMAT, historyRecordId, REVIEWS_DIR, verifyReviewRecord, writeHistoryRecord } from "../review/record.js";
import { baselineFindings } from "./findings.js";
import type { AdoptionBaselineBody, AdoptionBaselineRecord, AdoptionBaselineState, CaptureResult, DirtyAdoptionPolicy } from "./types.js";
import { observeWorkingTree } from "./worktree.js";

export interface CaptureBaselineOptions {
  readonly graph: GraphReader & IndexedGraph;
  readonly registry?: AnalyzerRegistry;
  readonly historyWindow?: number;
  /** Only a human confirms adoption. */
  readonly actor: DecisionActor;
  /** Required when the working tree is dirty (HEAD_BASELINE or ABORT_AND_CLEAN). */
  readonly policy?: DirtyAdoptionPolicy;
  readonly clock?: () => Date;
}

const ADOPTION_FILE = /^adoption-[0-9a-f]{16}\.json$/u;

function fileHash(root: string, p: RepoPath): string | undefined {
  try {
    const abs = path.join(root, p);
    if (!fs.lstatSync(abs).isFile()) return undefined;
    return `sha256:${createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

/** The recorded baseline, verified, without Git (used by Review for provenance). */
export function loadAdoptionBaseline(root: string): { readonly status: "missing" | "present" | "incompatible"; readonly baseline?: AdoptionBaselineRecord; readonly path?: RepoPath; readonly reason?: string } {
  const dir = path.join(root, REVIEWS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => ADOPTION_FILE.test(n)).sort(compareUtf8);
  } catch {
    return { status: "missing" };
  }
  if (names.length === 0) return { status: "missing" };
  if (names.length > 1) return { status: "incompatible", reason: `${names.length} adoption baselines` };
  const rel = `${REVIEWS_DIR}/${names[0] ?? ""}` as RepoPath;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, rel), "utf8");
  } catch (error) {
    return { status: "incompatible", path: rel, reason: (error as Error).message };
  }
  const verified = verifyReviewRecord(text, rel);
  if (verified.value === undefined || verified.value.body.format !== ADOPTION_BASELINE_FORMAT || `${verified.value.id}.json` !== names[0]) {
    return { status: "incompatible", path: rel, reason: verified.diagnostics[0]?.message ?? "not an adoption baseline" };
  }
  return { status: "present", path: rel, baseline: JSON.parse(text) as AdoptionBaselineRecord };
}

/** Where the repository stands relative to its Adoption Baseline. Read-only. */
export async function getAdoptionBaselineStatus(root: string, options: { readonly historyLimit?: number } = {}): Promise<ParseResult<AdoptionBaselineState>> {
  const loaded = loadAdoptionBaseline(root);
  const base = { ...(loaded.path === undefined ? {} : { path: loaded.path }), ...(loaded.reason === undefined ? {} : { reason: loaded.reason }) };
  if (loaded.baseline === undefined) return success({ status: loaded.status === "missing" ? "missing" : "incompatible", ...base });
  const b = loaded.baseline;
  const withBaseline = { ...base, id: b.id, baseline: b };
  const git = await openGitProvider(root);
  if (git.value === undefined) return failure(git.diagnostics);
  const state = await git.value.repositoryState();
  if (state.value === undefined) return failure(state.diagnostics);
  if (state.value.headOid === b.git.headOid) return success({ status: "current", ...withBaseline });
  if (b.project.rootCommits.join() !== state.value.rootCommitOids.join()) return success({ status: "repository-diverged", ...withBaseline, reason: "different root commits" });
  const history = await git.value.listCommits({ maxCommits: options.historyLimit ?? 10_000 });
  if (history.value?.some((c) => c.oid === b.git.headOid) === true) return success({ status: "advanced", ...withBaseline });
  return success({ status: "repository-diverged", ...withBaseline, reason: state.value.shallow ? "baseline commit not in the (shallow) history" : "baseline commit not in HEAD's history" });
}

export async function captureAdoptionBaseline(root: string, options: CaptureBaselineOptions): Promise<ParseResult<CaptureResult>> {
  if (options.actor.kind !== "human") {
    return failure([createDiagnostic("ADOPTION_FORBIDDEN", `${options.actor.kind} "${options.actor.name}" cannot capture the Adoption Baseline; adoption is a human decision`)]);
  }
  const loaded = loadProjectTruth(root);
  if (loaded.value === undefined) return failure(loaded.diagnostics);
  const { truth } = loaded.value;
  const shared = { graph: options.graph, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.historyWindow === undefined ? {} : { historyWindow: options.historyWindow }) };
  const inspected = await inspectIndex(root, shared);
  if (inspected.value === undefined) return failure(inspected.diagnostics);
  if (inspected.value.status !== "current") {
    return failure([createDiagnostic("ADOPTION_INDEX_REQUIRED", `The index is ${inspected.value.status}; index the repository before capturing the Adoption Baseline`)]);
  }
  const git = await openGitProvider(root);
  if (git.value === undefined) return failure(git.diagnostics);
  const repo = await git.value.repositoryState();
  if (repo.value === undefined) return failure(repo.diagnostics);
  if (repo.value.headOid === undefined) return failure([createDiagnostic("ADOPTION_HEAD_REQUIRED", "The repository has no commit yet; commit once before capturing the Adoption Baseline")]);
  const tree = await observeWorkingTree(git.value);
  if (tree.value === undefined) return failure(tree.diagnostics);
  const wt = tree.value;
  if (wt.dirty && options.policy === undefined) {
    return failure([createDiagnostic("ADOPTION_DIRTY_POLICY_REQUIRED", `The working tree has changes (staged ${wt.counts.staged}, unstaged ${wt.counts.unstaged}, untracked ${wt.counts.untracked}); choose HEAD_BASELINE or ABORT_AND_CLEAN`)]);
  }
  if (wt.dirty && options.policy === "ABORT_AND_CLEAN") return success({ status: "aborted", reason: "dirty-working-tree", workingTree: wt });

  const indexState = readIndexState(root).state;
  if (indexState === undefined) return failure([createDiagnostic("ADOPTION_INDEX_REQUIRED", "The index state cannot be read; index the repository first")]);
  const provenance = await git.value.blobProvenance(wt.staged);
  const indexBlob = new Map((provenance.value ?? []).map((p) => [p.path, p.indexBlobOid] as const));
  const dirty = new Set<string>([...wt.staged, ...wt.unstaged, ...wt.untracked, ...wt.conflicted]);
  const { findings, skipped } = baselineFindings({ root, truth, graph: options.graph, stateDiagnostics: indexState.diagnostics, skip: dirty });
  const limitations = [
    ...(wt.dirty ? ["dirty-paths-not-baselined"] : []), ...(skipped > 0 ? ["findings-in-dirty-paths-skipped"] : []), ...(wt.truncated ? ["working-tree-list-truncated"] : []),
  ];
  const body: AdoptionBaselineBody = {
    format: "duo.adoption-baseline/1",
    project: { name: truth.config.name, rootCommits: repo.value.rootCommitOids },
    git: { headOid: repo.value.headOid, ...(repo.value.branch === undefined ? {} : { branch: repo.value.branch }), detached: repo.value.detached },
    truth: { digest: truthDigest(root, truth) },
    index: { graphSchemaVersion: indexState.graphSchemaVersion, stateToken: indexState.token },
    workingTree: {
      dirty: wt.dirty, policy: "HEAD_BASELINE",
      staged: wt.staged.map((p) => { const b = indexBlob.get(p); return { path: p, ...(b === undefined ? {} : { indexBlob: b }) }; }),
      unstaged: wt.unstaged.map((p) => { const h = fileHash(root, p); return { path: p, ...(h === undefined ? {} : { contentHash: h }) }; }),
      untracked: wt.untracked.map((p) => { const h = fileHash(root, p); return { path: p, ...(h === undefined ? {} : { contentHash: h }) }; }),
      conflicted: wt.conflicted, counts: wt.counts, excludedSecrets: wt.excludedSecrets, truncated: wt.truncated,
    },
    findings, limitations,
  };
  const id = historyRecordId("adoption", body);
  const existing = loadAdoptionBaseline(root);
  if (existing.status !== "missing" && existing.baseline?.id !== id) {
    return failure([createDiagnostic("ADOPTION_BASELINE_EXISTS", `An Adoption Baseline already exists (${existing.path ?? "reviews/"}${existing.reason === undefined ? "" : `, ${existing.reason}`}); it is not replaced`)]);
  }
  const recorded = { by: options.actor.name, at: (options.clock ?? (() => new Date()))().toISOString() };
  const written = await writeHistoryRecord(root, `${REVIEWS_DIR}/${id}.json` as RepoPath, { id, recorded, ...body }, id, body as unknown as Record<string, unknown>);
  if (written.value === undefined) return failure(written.diagnostics);
  const record = written.value.status === "unchanged" && existing.baseline !== undefined ? existing.baseline : { id, recorded, ...body };
  return success({ status: written.value.status === "created" ? "captured" : "unchanged", id, path: written.value.path, baseline: record, workingTree: wt });
}
