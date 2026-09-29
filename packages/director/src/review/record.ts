/**
 * Review Record (T13.1, AC-013-05). reviewChanges() never writes; recordReview() is the one explicit,
 * human action that keeps a Review as tracked history under .duo-project/reviews/ (ADR-006). The CLI
 * (duoctl review --record), the Web UI or any other human-approved surface call this same service;
 * MCP and agents cannot (REVIEW_RECORD_FORBIDDEN).
 *
 * A record keeps pointers to re-examine the Review, never a repository snapshot: identities of the
 * request and the diff, the verdict, claims (rule, subject, alignment, reason, evidence IDs,
 * blockEligible), evidence pointers (path, lines, blob, hash, hunk identity), a Knowledge Gap
 * summary and the Context dependency digests. No source text, no diff lines, no claim wording.
 *
 * Identity is content-addressed: "review-" + 16 hex of sha256 over the record body. Recording the same
 * deterministic Review again finds the same file and is a no-op; a file with that name but other
 * content (or an ID that does not match its content) is an integrity error and is never overwritten.
 * When and by whom stay in "recorded", outside the identity. Semantic assistance is a separate
 * supplement file with its own ID, so an LLM answer never rewrites the deterministic history.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  createDiagnostic, createFileExclusive, failure, guardWrite, sha256Text, stableJson, STATE_DIR_NAME, success,
  type DecisionActor, type Diagnostic, type ParseResult, type RepoPath,
} from "@duo-director/core";
import type { ReviewResult } from "./types.js";

export const REVIEW_RECORD_FORMAT = "duo.review-record/1";
export const REVIEW_ASSIST_FORMAT = "duo.review-assist/1";
/** T14.1: the Adoption Baseline is human-approved history too, with its own format and ID prefix. */
export const ADOPTION_BASELINE_FORMAT = "duo.adoption-baseline/2";
export const REVIEWS_DIR = `${STATE_DIR_NAME}/reviews`;

const ID_PREFIX: Readonly<Record<string, string>> = {
  [REVIEW_RECORD_FORMAT]: "review", [REVIEW_ASSIST_FORMAT]: "assist", [ADOPTION_BASELINE_FORMAT]: "adoption",
};

export interface RecordReviewOptions {
  readonly root: string;
  /** Only a human records (an explicit action such as duoctl review --record). */
  readonly actor: DecisionActor;
  /** Injectable clock for recorded.at (never part of the identity). */
  readonly clock?: () => Date;
}

export interface RecordedFile {
  readonly id: string;
  readonly path: RepoPath;
  /** created: written now. unchanged: the same record already existed (nothing written). */
  readonly status: "created" | "unchanged";
}

export interface RecordReviewResult extends RecordedFile {
  /** The semantic assistance supplement, when the Review has a successful one. */
  readonly assist?: RecordedFile;
}

/** Content-addressed ID of a history record body: prefix + 16 hex of sha256(stable JSON). */
export const historyRecordId = (prefix: string, body: unknown) => `${prefix}-${sha256Text(stableJson(body)).slice(7, 23)}`;
const hexId = historyRecordId;

/** The deterministic content of a record: pointers and structured fields only. */
export function reviewRecordBody(result: ReviewResult): Record<string, unknown> | undefined {
  const diff = result.diff;
  if (result.status !== "ready" || diff === undefined || result.verdict === undefined) return undefined;
  return {
    format: REVIEW_RECORD_FORMAT,
    review: { format: result.format, verdict: result.verdict, verdictBasis: result.verdictBasis },
    request: result.request,
    baseline: result.baseline,
    diff: {
      identity: diff.identity, from: diff.from, to: diff.to,
      files: diff.files.map((f) => ({
        path: f.path, ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }), kind: f.kind, ...(f.similarity === undefined ? {} : { similarity: f.similarity }),
        binary: f.binary, ...(f.oldOid === undefined ? {} : { oldBlob: f.oldOid }), ...(f.newOid === undefined ? {} : { newBlob: f.newOid }),
        hunks: f.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, evidenceId: h.evidenceId })),
        evidenceIds: f.evidenceIds, ...(f.provenance === undefined ? {} : { provenance: f.provenance }),
      })),
    },
    claims: result.claims.map((c) => ({
      id: c.id, rule: c.rule, subject: c.subject, alignment: c.alignment, reason: c.reason, evidenceIds: c.evidenceIds, basis: c.basis,
      enforced: c.enforced, blockEligible: c.blockEligible, drift: c.drift, semanticCandidate: c.semanticCandidate,
      ...(c.violationKey === undefined ? {} : { violationKey: c.violationKey }), ...(c.provenance === undefined ? {} : { provenance: c.provenance }),
    })),
    evidence: result.evidence.map((e) => ({
      id: e.id, basis: e.basis, kind: e.kind, ...(e.contentHash === undefined ? {} : { contentHash: e.contentHash }), pointer: e.pointer,
      ...(e.metadata === undefined ? {} : { metadata: e.metadata }),
    })),
    gaps: result.gaps === undefined ? null : {
      requiresHumanInput: result.gaps.requiresHumanInput, ...(result.gaps.primary === undefined ? {} : { primary: result.gaps.primary }),
      gaps: result.gaps.gaps.filter((g) => g.action !== "ignore").map((g) => ({
        id: g.id, source: g.source, kind: g.kind, action: g.action, relevance: g.relevance, ...(g.key === undefined ? {} : { key: g.key }),
        ...(g.location === undefined ? {} : { location: g.location }), ...(g.resolution === undefined ? {} : { resolution: g.resolution }),
      })),
    },
    context: result.context ?? null,
    limitations: result.limitations.map((l) => l.code),
  };
}

function assistBody(reviewId: string, result: ReviewResult): Record<string, unknown> | undefined {
  const a = result.semanticAssist;
  if (a.status !== "success") return undefined;
  return {
    format: REVIEW_ASSIST_FORMAT, review: reviewId, status: a.status, ...(a.provider === undefined ? {} : { provider: a.provider }),
    claims: a.claims.map((c) => ({ claimId: c.claimId, alignment: c.alignment, evidenceIds: c.evidenceIds, basis: c.basis, blockEligible: c.blockEligible })),
    evidence: a.evidence.map((e) => ({ id: e.id, basis: e.basis, kind: e.kind, ...(e.contentHash === undefined ? {} : { contentHash: e.contentHash }), pointer: e.pointer })),
    ...(a.verdict === undefined ? {} : { verdict: a.verdict }),
    skippedChecks: a.skippedChecks,
  };
}

/**
 * Checks a record file's integrity: its format and that its ID is the hash of its content
 * (everything but id and recorded). Returns the body on success.
 */
export function verifyReviewRecord(text: string, path = "record"): ParseResult<{ readonly id: string; readonly body: Record<string, unknown> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", `${path} is not valid JSON: ${(error as Error).message}`, { path })]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", `${path} is not a record object`, { path })]);
  const body: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const id = body.id;
  delete body.id;
  delete body.recorded;
  const format = body.format;
  const prefix = typeof format === "string" ? ID_PREFIX[format] : undefined;
  if (prefix === undefined) return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", `${path} has format ${String(format)}`, { path })]);
  const expected = hexId(prefix, body);
  if (id !== expected) return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", `${path}: id ${String(id)} does not match its content (${expected})`, { path })]);
  return success({ id: expected, body });
}

/**
 * Writes a content-addressed history record under reviews/ (human-history boundary, no symlink,
 * exclusive create). An existing file with the same body is "unchanged"; any other content under the
 * same name is an integrity error and is never overwritten.
 */
export async function writeHistoryRecord(root: string, path: RepoPath, file: Record<string, unknown>, id: string, body: Record<string, unknown>): Promise<ParseResult<RecordedFile>> {
  const guarded = guardWrite(root, path, "human-history", { restrictTo: [`${REVIEWS_DIR}/`] });
  if (guarded.value === undefined) return failure(guarded.diagnostics);
  try {
    if (await createFileExclusive(guarded.value.absolute, `${JSON.stringify(file, null, 2)}\n`)) return success({ id, path, status: "created" });
    const existing = verifyReviewRecord(await fsp.readFile(guarded.value.absolute, "utf8"), path);
    if (existing.value === undefined) return failure(existing.diagnostics);
    if (stableJson(existing.value.body) !== stableJson(body)) {
      return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", `${path} exists with other content under the same ID; it is not overwritten`, { path })]);
    }
    return success({ id, path, status: "unchanged" });
  } catch (error) {
    return failure([createDiagnostic("FILE_WRITE_ERROR", `Cannot record ${path}: ${(error as Error).message}`, { path })]);
  }
}

/** Records a ready Review under .duo-project/reviews/ (human only). Never overwrites an existing record. */
export async function recordReview(result: ReviewResult, options: RecordReviewOptions): Promise<ParseResult<RecordReviewResult>> {
  if (options.actor.kind !== "human") {
    return failure([createDiagnostic("REVIEW_RECORD_FORBIDDEN", `${options.actor.kind} "${options.actor.name}" cannot record a Review; recording is an explicit human action`)]);
  }
  const body = reviewRecordBody(result);
  if (body === undefined) return failure([createDiagnostic("REVIEW_NOT_RECORDABLE", `Only a ready Review with a diff and a verdict is recorded (status ${result.status})`)]);
  const id = hexId("review", body);
  const recorded = { by: options.actor.name, at: (options.clock ?? (() => new Date()))().toISOString() };
  const main = await writeHistoryRecord(options.root, `${REVIEWS_DIR}/${id}.json` as RepoPath, { id, recorded, ...body }, id, body);
  if (main.value === undefined) return failure(main.diagnostics);
  const supplement = assistBody(id, result);
  if (supplement === undefined) return success(main.value);
  const assistId = hexId("assist", supplement);
  const assist = await writeHistoryRecord(options.root, `${REVIEWS_DIR}/${id}.${assistId}.json` as RepoPath, { id: assistId, recorded, ...supplement }, assistId, supplement);
  const diagnostics: Diagnostic[] = [...assist.diagnostics];
  return assist.value === undefined ? failure(diagnostics) : success({ ...main.value, assist: assist.value }, diagnostics);
}

export interface ReviewRecordEntry {
  readonly id: string;
  readonly path: RepoPath;
  readonly recorded?: { readonly by?: string; readonly at?: string };
  /** The verified record body (pointers and structured fields only). */
  readonly body: Record<string, unknown>;
  /** The semantic assistance supplement of this review, when one was recorded (kept apart, T13.1). */
  readonly assist?: { readonly id: string; readonly path: RepoPath; readonly body: Record<string, unknown> };
}

/**
 * Human-recorded Review Records under .duo-project/reviews/ (T18.1, read-only): each verified
 * review-*.json with its separate assist supplement. Adoption baselines are not reviews and are left
 * out. A file that fails verification is reported, never shown as history. Newest recorded first.
 */
export async function listReviewRecords(root: string): Promise<ParseResult<readonly ReviewRecordEntry[]>> {
  const dir = path.join(root, REVIEWS_DIR);
  let names: string[];
  try {
    // A repository could contain a symlinked Truth/reviews directory. Do not read outside it.
    for (const part of [path.dirname(dir), dir]) {
      const stat = await fsp.lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return failure([createDiagnostic("REVIEW_RECORD_INTEGRITY", "Review history directory is not a real project directory")]);
      }
    }
    names = (await fsp.readdir(dir)).filter((n) => /^review-[0-9a-f]{16}(?:\.assist-[0-9a-f]{16})?\.json$/u.test(n)).sort();
  } catch {
    return success([]);
  }
  const diagnostics: Diagnostic[] = [];
  const read = async (name: string) => {
    const rel = `${REVIEWS_DIR}/${name}` as RepoPath;
    try {
      const stat = await fsp.lstat(path.join(dir, name));
      if (!stat.isFile()) return undefined;
      const text = await fsp.readFile(path.join(dir, name), "utf8");
      const verified = verifyReviewRecord(text, rel);
      diagnostics.push(...verified.diagnostics);
      if (verified.value === undefined) return undefined;
      const recorded = (JSON.parse(text) as { recorded?: { by?: string; at?: string } }).recorded;
      return { id: verified.value.id, path: rel, body: verified.value.body, ...(recorded === undefined ? {} : { recorded }) };
    } catch (error) {
      diagnostics.push(createDiagnostic("REVIEW_RECORD_INTEGRITY", `Cannot read ${rel}: ${(error as Error).message}`, { path: rel }));
      return undefined;
    }
  };
  const reviews = new Map<string, ReviewRecordEntry>();
  const assists: { review: string; entry: NonNullable<Awaited<ReturnType<typeof read>>> }[] = [];
  for (const name of names) {
    const entry = await read(name);
    if (entry === undefined) continue;
    const m = /^(review-[0-9a-f]{16})\.assist-/u.exec(name);
    if (m !== null && entry.body.format === REVIEW_ASSIST_FORMAT) assists.push({ review: m[1] as string, entry });
    else if (m === null && entry.body.format === REVIEW_RECORD_FORMAT) reviews.set(entry.id, entry);
  }
  for (const a of assists) {
    const r = reviews.get(a.review);
    if (r !== undefined && a.entry.body.review === r.id) reviews.set(r.id, { ...r, assist: { id: a.entry.id, path: a.entry.path, body: a.entry.body } });
  }
  const list = [...reviews.values()].sort((a, b) => (b.recorded?.at ?? "").localeCompare(a.recorded?.at ?? "") || a.id.localeCompare(b.id));
  return success(list, diagnostics);
}
