/**
 * Evidence-backed Review (TASK-013).
 *
 *   ReviewRequest → freshness (read-only) → Git diff → diff seeds → Review context (Context Compiler,
 *   profile "review", explicit diff seeds) [+ task context] → Knowledge Gap assessment →
 *   deterministic rules → evidence → optional semantic assistance → claims → verdict
 *
 * Each stage is its own module. The deterministic review is complete before any LLM call, and its
 * result body (everything but ReviewPerformance) is byte-identical for the same Project Truth,
 * Graph, Git state, diff and request when semantic assistance is off.
 */
import { performance } from "node:perf_hooks";
import { openGitProvider, type AnalyzerRegistry } from "@duo-director/analyzer";
import {
  canonicalDiagnostics, canonicalSourceText, compareUtf8, fileRef, loadProjectTruth, readSourceFile, requireCompleteTruth, sha256Text, stableJson, STATE_DIR_NAME, success,
  type Diagnostic, type EvidenceBasis, type ParseResult,
} from "@duo-director/core";
import type { GitDiffEnd, GitProvider } from "@duo-director/analyzer";
import { inspectIndex, readIndexState, type GraphReader, type IndexedGraph } from "@duo-director/graph";
import { compileContext } from "../context/compile.js";
import { analysisLimitations } from "../context/candidates.js";
import { SourceReader } from "../context/retrieve.js";
import type { TokenCountMemo } from "../context/metrics.js";
import type { ContextPacket, ContextResult } from "../context/types.js";
import { EvidenceStore } from "../evidence/store.js";
import { assessKnowledgeGaps } from "../gap/assess.js";
import type { LLMProvider } from "../llm/contract/types.js";
import { loadAdoptionBaseline } from "../adoption/baseline.js";
import { PRE_T18_STRUCTURAL_LANGUAGES } from "../adoption/types.js";
import { reviewVerdict } from "./aggregate.js";
import type { RuleContext } from "./claims.js";
import { collectDiff } from "./diff.js";
import { externalSourceDrift } from "./drift.js";
import {
  constraintCompliance, decisionForbids, decisionForbidsImport, decisionGovernance, decisionIntegrity, declaredReferences, requirementImplementation, scopeRelevance,
  supersedeIntegrity, testCoverage, testResults,
} from "./rules.js";
import { unlinkedAdditions } from "./scope.js";
import { diffSeeds } from "./seeds.js";
import { semanticAssist } from "./semantic.js";
import type { Alignment, ChangedFile, ReviewClaim, ReviewLimitation, ReviewPerformance, ReviewRequest, ReviewRequestIdentity, ReviewResult } from "./types.js";

export interface ReviewOptions {
  readonly graph: GraphReader & IndexedGraph;
  readonly registry?: AnalyzerRegistry;
  readonly historyWindow?: number;
  /** Used only when the request allows semantic assistance and project.yaml enables a provider. */
  readonly llm?: LLMProvider;
  /** Reuse LLM answers under .duo-project/cache/llm/ (provider cacheIdentity required). Default false. */
  readonly llmCache?: boolean;
  readonly signal?: AbortSignal;
  /** In-memory repository token counts (TASK-019); default: one memo for this Review's two compiles. */
  readonly tokenCounts?: TokenCountMemo;
}

const packetScopeIds = (p: ContextPacket | undefined): ReadonlySet<string> =>
  new Set(p === undefined ? [] : [...p.intent.requirements, ...p.intent.constraints, ...p.decisions.active, ...p.code, ...p.tests, ...p.issues].map((i) => i.id).concat(p.omittedCandidates.map((o) => o.id)));

/** Documentation and data files: no structural analysis is expected, so they are no limitation. */
const DATA_FILE = /\.(?:md|markdown|mdx|txt|rst|adoc|json|jsonc|json5|ya?ml|toml|lock|ini|cfg|conf|properties|xml|csv|tsv|svg|env\.example)$|(?:^|\/)(?:\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|LICENSE|NOTICE)$/iu;

/**
 * What the analyzers could not see in the changed files (T18.0): a changed file without a structural
 * analyzer is reviewed at file level only (path, diff, Git, Truth references); analyzed files carry
 * their language's import and call limits. Limitations lower confidence; they never create a claim.
 */
function analysisLimitsOf(files: readonly ChangedFile[], graph: GraphReader): ReviewLimitation[] {
  const languages = new Map<string, string | undefined>();
  for (const f of files) {
    if (f.kind === "deleted" || f.binary || f.path.startsWith(`${STATE_DIR_NAME}/`)) continue;
    const language = graph.getNode(fileRef(f.path))?.payload.language;
    if (typeof language === "string") languages.set(f.path, language);
    else if (!DATA_FILE.test(f.path)) languages.set(f.path, undefined);
  }
  return analysisLimitations(languages).map((l) => (l.code === "structural-analysis-unavailable"
    ? { code: l.code, message: `${[...languages.values()].filter((x) => x === undefined).length} changed file(s) have no structural analyzer: they are reviewed at file level (path, diff, Git, Truth references), without symbols, tests, imports or calls.` }
    : l));
}

function limitationsOf(files: ReviewResult["diff"], packet: ContextPacket | undefined, hasTask: boolean, taskReady: boolean): ReviewLimitation[] {
  const out: ReviewLimitation[] = [...(packet?.limitations ?? []).filter((l) => l.code === "calls-exact-only" || l.code === "traversal-truncated" || l.code === "omitted")];
  const f = files?.files ?? [];
  if (f.some((x) => x.kind === "deleted")) out.push({ code: "deleted-unresolved", message: "Deleted files have no current graph node; they are reviewed from Git evidence only (old path, old blob, removed lines)." });
  if (f.some((x) => x.oldPath !== undefined)) out.push({ code: "rename-heuristic", message: "Renames come from Git similarity; old and new symbols are not assumed to be the same entity." });
  if (f.some((x) => x.binary)) out.push({ code: "binary-change", message: "Binary files are recorded as changed without content." });
  if (!hasTask) out.push({ code: "no-task-scope", message: "No task was given, so scope drift against a task context is not checked." });
  else if (!taskReady) out.push({ code: "task-scope-unavailable", message: "The task did not resolve to a context; scope drift is not checked." });
  if (f.length === 0) out.push({ code: "empty-diff", message: "The diff has no reviewable changes." });
  return out;
}

const zeroMetrics = {
  changedFiles: 0, changedHunks: 0, diffSeeds: 0, claims: { ALIGNED: 0, PARTIAL: 0, CONFLICT: 0, UNKNOWN: 0 },
  evidence: { "project-truth": 0, repository: 0, git: 0, test: 0, llm: 0 }, contextTokens: 0, taskContextTokens: 0, semanticCandidates: 0, llmCalls: 0, llmCacheHits: 0,
};

/** Marks untracked or changed .duo-project files whose content on the reviewed side equals the baseline's bootstrapTruth. */
async function classifyBootstrap(root: string, git: GitProvider, to: GitDiffEnd, files: readonly ChangedFile[], bootstrap: readonly { readonly path: string; readonly contentHash: string }[]): Promise<ChangedFile[]> {
  const expected = new Map(bootstrap.map((b) => [b.path, b.contentHash] as const));
  const out: ChangedFile[] = [];
  for (const f of files) {
    const hash = expected.get(f.path);
    let text: string | undefined;
    if (hash !== undefined && f.kind !== "deleted" && f.path.startsWith(`${STATE_DIR_NAME}/`)) {
      if (to === "WORKTREE") text = readSourceFile(root, f.path).value;
      else {
        const blob = await git.readBlob(to === "INDEX" || to === "HEAD" ? to : { commit: to.commit }, f.path);
        text = blob.value === undefined ? undefined : canonicalSourceText(new TextDecoder("utf-8").decode(blob.value));
      }
    }
    out.push(text !== undefined && sha256Text(canonicalSourceText(text)) === hash ? { ...f, provenance: "adoption-bootstrap" } : f);
  }
  return out;
}

const endLabel = (end: GitDiffEnd) => (typeof end === "string" ? end : `commit:${end.commit}`);

/** The request's semantic input and its identity (T13.1). includeSemanticAssist is left out on purpose. */
export function reviewRequestIdentity(request: ReviewRequest): ReviewRequestIdentity {
  const files = request.diff.files === undefined ? undefined : [...new Set(request.diff.files)].sort(compareUtf8);
  const testRun = request.testResults === undefined ? undefined : sha256Text(stableJson(request.testResults));
  const body = {
    task: (request.task ?? "").trim(), from: endLabel(request.diff.from), to: endLabel(request.diff.to),
    ...(files === undefined ? {} : { files }), ...(request.budget === undefined ? {} : { budget: request.budget }), ...(testRun === undefined ? {} : { testRun }),
  };
  return { identity: sha256Text(stableJson(body)), ...body };
}

export async function reviewChanges(root: string, request: ReviewRequest, options: ReviewOptions): Promise<ParseResult<{ readonly result: ReviewResult; readonly performance: ReviewPerformance }>> {
  const t0 = performance.now();
  const time = { freshnessMs: 0, diffMs: 0, contextMs: 0, gapMs: 0, rulesMs: 0, semanticMs: 0 };
  const diagnostics: Diagnostic[] = [];
  const perf = (): ReviewPerformance => ({
    totalMs: Math.round(performance.now() - t0), freshnessMs: Math.round(time.freshnessMs), diffMs: Math.round(time.diffMs), contextMs: Math.round(time.contextMs),
    gapMs: Math.round(time.gapMs), rulesMs: Math.round(time.rulesMs), semanticMs: Math.round(time.semanticMs),
  });
  const shared = { graph: options.graph, ...(options.registry === undefined ? {} : { registry: options.registry }), ...(options.historyWindow === undefined ? {} : { historyWindow: options.historyWindow }) };
  const requestIdentity = reviewRequestIdentity(request);
  // T14.1: provenance against the Adoption Baseline (read-only; missing or unreadable → no provenance).
  const adoption = loadAdoptionBaseline(root);
  const baseline = { status: adoption.status, ...(adoption.baseline === undefined ? {} : { id: adoption.baseline.id }) };

  // 1. Freshness: a Review never uses a stale graph and never indexes.
  const tFresh = performance.now();
  const inspected = await inspectIndex(root, shared);
  time.freshnessMs = performance.now() - tFresh;
  if (inspected.value === undefined) return { diagnostics: inspected.diagnostics };
  const freshness = { status: inspected.value.status, fullRebuildRequired: inspected.value.status === "missing" || inspected.value.status === "incompatible" };
  const noAssist = { status: "not-requested" as const, candidates: [], skippedChecks: [], claims: [], evidence: [], calls: 0, cacheHits: 0 };
  if (inspected.value.status !== "current") {
    return success({ result: { format: "duo.review/1", status: "index-required", request: requestIdentity, baseline, freshness, seeds: [], verdictBasis: { blocking: [], ask: [], warn: [] }, claims: [], evidence: [], limitations: [], semanticAssist: noAssist, metrics: zeroMetrics, diagnostics: [] }, performance: perf() });
  }
  // T40 (N1): never a verdict on partial Truth; a Decision the loader left out must not turn into a PASS.
  const loaded = requireCompleteTruth(loadProjectTruth(root));
  if (loaded.value === undefined) return { diagnostics: loaded.diagnostics };
  const { truth } = loaded.value;

  // 2. Diff, 3. diff seeds.
  let t = performance.now();
  const git = await openGitProvider(root);
  if (git.value === undefined) return { diagnostics: git.diagnostics };
  const store = new EvidenceStore();
  const diff = await collectDiff(git.value, root, request.diff, store);
  diagnostics.push(...diff.diagnostics);
  if (diff.value === undefined) return { diagnostics: canonicalDiagnostics(diagnostics) };
  // T15.1: Truth files still exactly as init wrote them (Adoption Baseline bootstrapTruth) are classified, not reviewed.
  const allFiles = await classifyBootstrap(root, git.value, request.diff.to, diff.value.files, adoption.baseline?.bootstrapTruth ?? []);
  const files = allFiles.filter((f) => f.provenance === undefined);
  const seeds = diffSeeds(files, options.graph, truth);
  time.diffMs = performance.now() - t;

  // 4. Review context (explicit diff seeds) and, with a task, the task-only context for scope drift.
  t = performance.now();
  const task = (request.task ?? "").trim();
  // One freshness snapshot and one token-count memo for both compiles (the metrics are the same without it).
  const withInspection = { ...shared, inspection: inspected.value, tokenCounts: options.tokenCounts ?? new Map() };
  const budget = request.budget === undefined ? {} : { budget: request.budget };
  let reviewContext: ContextResult | undefined;
  if (seeds.length > 0 || task !== "") {
    const r = await compileContext(root, { task, ...budget, profile: "review", explicitSeeds: seeds.map((s) => s.entity) }, withInspection);
    diagnostics.push(...r.diagnostics);
    reviewContext = r.value;
  }
  let taskContext: ContextResult | undefined;
  if (task !== "") {
    const r = await compileContext(root, { task, ...budget }, withInspection);
    diagnostics.push(...r.diagnostics);
    taskContext = r.value;
  }
  time.contextMs = performance.now() - t;
  const reviewPacket = reviewContext?.status === "ready" ? reviewContext.packet : undefined;

  // 5. Knowledge Gap assessment (the authority for ASK, C100).
  const tGap = performance.now();
  const gaps = reviewContext === undefined ? undefined : assessKnowledgeGaps({ request: { task }, result: reviewContext, truth });
  time.gapMs = performance.now() - tGap;

  // 6. Deterministic rules.
  t = performance.now();
  const ctx: RuleContext = {
    root, truth, graph: options.graph, git: git.value, files, seeds, store, reader: new SourceReader(root), identity: diff.value.identity,
    from: request.diff.from, to: request.diff.to, fromLabel: diff.value.from, toLabel: diff.value.to, task,
    ...(reviewPacket === undefined ? {} : { reviewPacket }),
    ...(taskContext?.status === "ready" && taskContext.packet !== undefined ? { taskScope: packetScopeIds(taskContext.packet) } : {}),
    stateDiagnostics: readIndexState(root).state?.diagnostics ?? [],
    ...(request.testResults === undefined ? {} : { testResults: request.testResults }),
    ...(adoption.baseline === undefined ? {} : { baselineKeys: new Set(adoption.baseline.findings.map((f) => f.key)) }),
    ...(adoption.baseline === undefined ? {} : { baselineStructuralLanguages: new Set(adoption.baseline.analysis?.structuralLanguages ?? PRE_T18_STRUCTURAL_LANGUAGES) }),
    ...(adoption.baseline?.evaluatedRules === undefined ? {} : { baselineEvaluatedRules: new Set<string>(adoption.baseline.evaluatedRules) }),
    ...(adoption.baseline === undefined ? {} : { baselineRecordedAt: adoption.baseline.recorded.at }),
  };
  const integrity = await decisionIntegrity(ctx);
  const forbids = await decisionForbids(ctx);
  const imports = await decisionForbidsImport(ctx);
  const drift = await externalSourceDrift(ctx);
  const additions = unlinkedAdditions(ctx);
  const conflicted = new Set([...forbids, ...imports.claims].map((c) => c.subject.id));
  const claims: ReviewClaim[] = [
    ...integrity, ...supersedeIntegrity(ctx), ...forbids, ...imports.claims, ...decisionGovernance(ctx, conflicted), ...declaredReferences(ctx),
    ...requirementImplementation(ctx), ...testCoverage(ctx), ...testResults(ctx), ...constraintCompliance(ctx), ...scopeRelevance(ctx, additions.covered),
    ...additions.claims, ...drift.claims,
  ].sort((a, b) => compareUtf8(a.rule, b.rule) || compareUtf8(a.id, b.id));
  time.rulesMs = performance.now() - t;
  const verdict = reviewVerdict(claims, gaps);

  // 7. Optional semantic assistance, strictly after the deterministic review.
  t = performance.now();
  const semantic = await semanticAssist({
    root, truth, claims, store, verdict: verdict.verdict, requested: request.includeSemanticAssist ?? false, cache: options.llmCache ?? false,
    ...(options.llm === undefined ? {} : { provider: options.llm }), ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  time.semanticMs = performance.now() - t;

  const evidence = store.list();
  const count = <K extends string>(keys: readonly K[], values: readonly K[]) => Object.fromEntries(keys.map((k) => [k, values.filter((v) => v === k).length])) as Record<K, number>;
  const result: ReviewResult = {
    format: "duo.review/1", status: "ready", request: requestIdentity, baseline, freshness,
    diff: { identity: diff.value.identity, from: diff.value.from, to: diff.value.to, files: allFiles },
    seeds, verdict: verdict.verdict, verdictBasis: verdict.basis, claims, evidence,
    ...(gaps === undefined ? {} : { gaps }),
    context: {
      profile: "review", seeds: reviewPacket?.seeds.map((s) => s.id) ?? [],
      ...(reviewPacket === undefined ? {} : { review: reviewPacket.dependencyDigest }),
      ...(taskContext?.packet === undefined ? {} : { task: taskContext.packet.dependencyDigest }),
    },
    limitations: [
      ...limitationsOf({ identity: diff.value.identity, from: diff.value.from, to: diff.value.to, files }, reviewPacket, task !== "", taskContext?.status === "ready"),
      ...analysisLimitsOf(files, options.graph),
      ...drift.limitations,
      ...imports.limitations,
      ...(adoption.status === "incompatible" ? [{ code: "adoption-baseline-unusable", message: "The Adoption Baseline cannot be used (" + (adoption.reason ?? "unreadable") + "); violations are not told apart from pre-existing ones." }] : []),
    ],
    semanticAssist: semantic.assist,
    metrics: {
      changedFiles: diff.value.files.length, changedHunks: diff.value.files.reduce((n, f) => n + f.hunks.length, 0), diffSeeds: seeds.length,
      claims: count<Alignment>(["ALIGNED", "PARTIAL", "CONFLICT", "UNKNOWN"], claims.map((c) => c.alignment)),
      evidence: count<EvidenceBasis>(["project-truth", "repository", "git", "test", "llm"], [...evidence, ...semantic.assist.evidence].map((e) => e.basis)),
      contextTokens: reviewPacket?.metrics.budget.used ?? 0, taskContextTokens: taskContext?.packet?.metrics.budget.used ?? 0,
      semanticCandidates: semantic.assist.candidates.length, llmCalls: semantic.assist.calls, llmCacheHits: semantic.assist.cacheHits,
    },
    diagnostics: canonicalDiagnostics(diagnostics),
  };
  return success({ result, performance: perf() }, result.diagnostics);
}
