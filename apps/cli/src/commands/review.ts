/**
 * duoctl review (T15): the shared review operation. Default diff HEAD → WORKTREE; --staged is
 * HEAD → INDEX; --from/--to name any endpoints the Git provider accepts. Read-only: a stale index is
 * index-required (--refresh indexes first); only --record writes, through recordReview(). A verdict
 * is not a process error: the exit code follows it only with --fail-on (or --strict).
 */
import { provenanceLabel, recordReview, renderGapQuestions, reviewLlmMetric, type ReviewResult, type Verdict } from "@duo-director/director";
import { normalizeRepoPath, type RepoPath } from "@duo-director/core";
import { indexRepository } from "@duo-director/graph";
import { diffEnd, projectReview, withGraphWriter } from "@duo-director/integration";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, humanActor, operationFailure, requireProject, usage, withRegistry, type Env } from "./shared.js";

export interface ReviewOptions {
  readonly staged: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly files?: string;
  readonly task?: string;
  readonly budget?: number;
  readonly record: boolean;
  readonly refresh: boolean;
  readonly failOn?: "block" | "ask" | "warn";
  /** --semantic (T12B): ask the configured LLM provider for supplemental semantic checks. Off by default. */
  readonly semantic?: boolean;
}

const SEVERITY: Readonly<Record<Verdict, number>> = { PASS: 0, WARN: 1, ASK: 2, BLOCK: 3 };
const VERDICT_EXIT: Readonly<Record<Verdict, number>> = { PASS: EXIT.OK, WARN: EXIT.WARN, ASK: EXIT.ASK, BLOCK: EXIT.BLOCK };

function renderReview(env: Env, r: ReviewResult): string[] {
  const L = env.locale;
  if (r.status === "index-required") return [t(L, "index.required", { status: r.freshness.status })];
  const out = [t(L, "review.head", { verdict: r.verdict ?? "-", claims: r.claims.length, files: r.diff?.files.length ?? 0, llm: r.metrics.llmCalls })];
  const ev = new Map(r.evidence.map((e) => [e.id, e] as const));
  const shown = r.claims.filter((c) => env.verbose || c.alignment !== "ALIGNED");
  for (const c of shown) {
    const tags = [c.blockEligible ? "blocking" : "", c.provenance === undefined ? "" : provenanceLabel(c.provenance, L), c.drift ? "drift" : ""].filter((x) => x !== "").join(", ");
    out.push(`  ${c.alignment.padEnd(9)} ${c.rule.padEnd(26)} ${c.subject.id} · ${c.reason}${tags === "" ? "" : ` [${tags}]`}`);
    const pointers = c.evidenceIds.map((id) => ev.get(id)?.pointer).filter((p) => p?.path !== undefined).slice(0, 3)
      .map((p) => `${p?.path ?? ""}${p?.lines === undefined ? "" : `:${p.lines[0]}-${p.lines[1]}`}`);
    if (pointers.length > 0) out.push(`            evidence: ${pointers.join(", ")}`);
  }
  const aligned = r.claims.length - shown.length;
  if (aligned > 0) out.push(t(L, "review.aligned", { n: aligned }));
  const bootstrap = r.diff?.files.filter((f) => f.provenance === "adoption-bootstrap").length ?? 0;
  if (bootstrap > 0) out.push(t(L, "review.bootstrap", { n: bootstrap }));
  if (r.gaps !== undefined) {
    const q = renderGapQuestions(r.gaps, { locale: L });
    if (q.primaryQuestion !== undefined || q.notes.length > 0) {
      out.push(t(L, "review.gaps"));
      if (q.primaryQuestion !== undefined) out.push(`  ? ${q.primaryQuestion}`);
      out.push(...q.additionalQuestions.map((a) => `  ? ${a.question}`), ...q.notes.map((n) => `  - ${n.note}`));
    }
  }
  if (r.limitations.length > 0) out.push(t(L, "review.limitations"), ...r.limitations.map((l) => `  ${l.code}`));
  const a = r.semanticAssist;
  if (a.status !== "not-requested") {
    const who = a.provider === undefined ? "" : ` · ${a.provider.id}${a.provider.model === undefined ? "" : ` ${a.provider.model}`}`;
    out.push(t(L, "review.semantic", { status: a.status + (a.failure === undefined ? "" : ` (${a.failure})`) + who + (a.cacheHits > 0 ? " · cached" : "") }));
    out.push(...a.claims.filter((c) => env.verbose || c.alignment !== "ALIGNED").map((c) => `  ${c.alignment.padEnd(9)} ${c.claimId} · ${c.reason}`));
    if (a.verdict !== undefined && a.verdict !== r.verdict) out.push(t(L, "review.semantic-verdict", { verdict: a.verdict }));
  }
  if (r.baseline.status === "missing") out.push(t(L, "review.baseline-missing"));
  if (r.verdict === "PASS") out.push(t(L, "review.pass"));
  return out;
}

export async function reviewCommand(env: Env, options: ReviewOptions): Promise<Outcome> {
  const project = requireProject(env, "review");
  if (project.value === undefined) return project.outcome as Outcome;
  if (options.staged && (options.from !== undefined || options.to !== undefined)) return usage("review", "--staged cannot be combined with --from/--to");
  const from = options.from === undefined ? "HEAD" as const : diffEnd(options.from);
  const to = options.staged ? "INDEX" as const : options.to === undefined ? "WORKTREE" as const : diffEnd(options.to);
  let files: RepoPath[] | undefined;
  if (options.files !== undefined) {
    files = [];
    for (const f of options.files.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      const p = normalizeRepoPath(f).value;
      if (p === undefined) return usage("review", `--files: "${f}" is not a repository-relative path`);
      files.push(p);
    }
  }
  return withRegistry(async (registry) => {
    if (options.refresh) {
      const r = await withGraphWriter(env.root, (store) => indexRepository(env.root, { store, registry }));
      if (r.value === undefined) return failed("review", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
    }
    const op = await projectReview(env.root, {
      diff: { from, to, ...(files === undefined ? {} : { files }) },
      ...(options.task === undefined ? {} : { task: options.task }), ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.semantic === true ? { includeSemanticAssist: true } : {}),
    }, { registry });
    if (op.kind !== "ok") return operationFailure(env, "review", op);
    const r = op.payload;
    const metric = { status: r.status, ...(r.verdict === undefined ? {} : { reviewVerdict: r.verdict }), reviewClaims: r.claims.length, ...reviewLlmMetric(r) };
    if (r.status === "index-required") {
      return { command: "review", exitCode: EXIT.ACTION_REQUIRED, result: r, meta: { performance: op.performance }, diagnostics: [], human: renderReview(env, r), metric };
    }
    const human = renderReview(env, r);
    let record: unknown = undefined;
    if (options.record) {
      const rec = await recordReview(r, { root: env.root, actor: await humanActor(env.root), clock: () => env.io.now() });
      if (rec.value === undefined) return failed("review", EXIT.ERROR, rec.diagnostics, [...human, ...diagLines(rec.diagnostics)], r, metric);
      record = rec.value;
      human.push(t(env.locale, "review.recorded", { path: rec.value.path, status: rec.value.status }));
    }
    const verdict = r.verdict ?? "PASS";
    const threshold = options.failOn === undefined ? undefined : SEVERITY[options.failOn === "block" ? "BLOCK" : options.failOn === "ask" ? "ASK" : "WARN"];
    const exitCode = threshold !== undefined && SEVERITY[verdict] >= threshold ? VERDICT_EXIT[verdict] : EXIT.OK;
    return { command: "review", exitCode, result: r, meta: { performance: op.performance, ...(record === undefined ? {} : { record }) }, diagnostics: op.diagnostics, human, metric };
  });
}
