/**
 * Context Compiler (TASK-010): what should the coding agent see for this task?
 *
 *   freshness (read-only inspectIndex) → Project Truth → seed resolution → weighted traversal →
 *   candidates and ranking → source retrieval → Packet Dependency Digest → [cache] → budget
 *   allocation → Context Packet (+ Markdown via render.ts) → metrics
 *
 * Deterministic, no LLM call (ADR-008): llmCalls is always 0. The Compiler never indexes: a graph
 * that is not current is reported as index-required. The only writes are the opt-in regenerable
 * caches under .duo-project/cache/.
 */
import { performance } from "node:perf_hooks";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { canonicalDiagnostics, createDiagnostic, failure, loadProjectTruth, requireCompleteTruth, success, type Diagnostic, type ParseResult } from "@duo-director/core";
import { inspectIndex, type GraphReader, type IndexedGraph, type IndexInspection } from "@duo-director/graph";
import { redactSecrets } from "./redact.js";
import { TOKEN_ESTIMATOR, truncateToTokens } from "../tokens/index.js";
import { readCachedPacket, writeCachedPacket } from "./cache.js";
import { callableGroups } from "./callables.js";
import { planContext } from "./candidates.js";
import { packetDependencyDigest } from "./digest.js";
import { expandCandidates } from "./expand.js";
import { TokenMeter } from "./meter.js";
import { reduction, repositoryTokens, type TokenCountMemo } from "./metrics.js";
import { packContext } from "./pack.js";
import { DEFAULT_LIMITS, MAX_BUDGET, MIN_BUDGET, TASK_TOKEN_LIMIT } from "./policy.js";
import { SourceReader } from "./retrieve.js";
import { resolveSeeds } from "./seeds.js";
import type { ContextMetrics, ContextPacket, ContextPerformance, ContextProfile, ContextRequest, ContextResult, KnowledgeSignal } from "./types.js";

export interface CompileContextOptions {
  /** The project graph, only read. */
  readonly graph: GraphReader & IndexedGraph;
  /** Analyzers for the freshness check; default: the TypeScript/JavaScript registry. */
  readonly registry?: AnalyzerRegistry;
  readonly historyWindow?: number;
  /** Reuse and store Packets and per-file token counts under .duo-project/cache/. Default false. */
  readonly cache?: boolean;
  /** Candidate limit (default 200). Part of the Packet Dependency Digest. */
  readonly nodeLimit?: number;
  /**
   * A read-only inspection the caller already made for this repository state (Review inspects
   * once and compiles twice). Only a "current" inspection is accepted; otherwise it is ignored.
   */
  readonly inspection?: IndexInspection;
  /**
   * In-memory repository token counts to reuse (TASK-019): Review shares one across its two compiles,
   * MCP and the UI keep one for their lifetime. Same metrics as without it; writes nothing.
   */
  readonly tokenCounts?: TokenCountMemo;
}

const MAX_TASK_CHARS = 20_000;

function validate(request: ContextRequest, defaultBudget: number): ParseResult<{ task: string; budget: number; profile: ContextProfile }> {
  const task = request.task.trim();
  const budget = request.budget ?? defaultBudget;
  const bad = (m: string) => failure<{ task: string; budget: number; profile: ContextProfile }>([createDiagnostic("CONTEXT_REQUEST_INVALID", m)]);
  if (task.length === 0 && (request.explicitSeeds ?? []).length === 0) return bad("task is empty");
  if (task.length > MAX_TASK_CHARS) return bad(`task is longer than ${MAX_TASK_CHARS} characters`);
  if (!Number.isInteger(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) return bad(`budget must be an integer between ${MIN_BUDGET} and ${MAX_BUDGET} (${TOKEN_ESTIMATOR.name} tokens)`);
  const profile = request.profile ?? "default";
  if (profile !== "default" && profile !== "review") return bad(`unknown profile "${String(request.profile)}"`);
  return success({ task, budget, profile });
}

export async function compileContext(root: string, request: ContextRequest, options: CompileContextOptions): Promise<ParseResult<ContextResult>> {
  const t0 = performance.now();
  const time = { freshnessMs: 0, seedMs: 0, traversalMs: 0, rankingMs: 0, retrievalMs: 0, tokenizationMs: 0, packingMs: 0, metricsMs: 0 };
  const perf = (): ContextPerformance => {
    const r = (n: number) => Math.round(n * 100) / 100;
    return { freshnessMs: r(time.freshnessMs), seedMs: r(time.seedMs), traversalMs: r(time.traversalMs), rankingMs: r(time.rankingMs),
      retrievalMs: r(time.retrievalMs), tokenizationMs: r(time.tokenizationMs), packingMs: r(time.packingMs), metricsMs: r(time.metricsMs), totalMs: r(performance.now() - t0) };
  };
  const diagnostics: Diagnostic[] = [];
  const useCache = options.cache ?? false;

  // 1. Freshness: read-only; a graph that is not current is never used silently.
  let t = performance.now();
  const inspected = options.inspection?.status === "current" ? success(options.inspection) : await inspectIndex(root, {
    graph: options.graph, ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.historyWindow === undefined ? {} : { historyWindow: options.historyWindow }),
  });
  time.freshnessMs = performance.now() - t;
  if (inspected.value === undefined) return failure(inspected.diagnostics);
  const freshness = { status: inspected.value.status, fullRebuildRequired: inspected.value.status === "incompatible" || inspected.value.status === "missing" };
  const idle = (status: ContextResult["status"], signals: readonly KnowledgeSignal[], extra: Partial<ContextResult> = {}): ParseResult<ContextResult> =>
    success({ status, freshness, signals, cache: { status: "off", written: false }, performance: perf(), diagnostics: canonicalDiagnostics(diagnostics), ...extra }, canonicalDiagnostics(diagnostics));
  if (inspected.value.status !== "current") return idle("index-required", []);

  // T40 (N1): an agent never receives a Context Packet built from partial Truth.
  const loaded = requireCompleteTruth(loadProjectTruth(root));
  if (loaded.value === undefined) return failure(loaded.diagnostics);
  const { truth } = loaded.value;
  const valid = validate(request, truth.config.context.defaultBudgetTokens);
  if (valid.value === undefined) return failure(valid.diagnostics);
  const { budget, profile } = valid.value;
  const quoted = truncateToTokens(redactSecrets(valid.value.task).text, TASK_TOKEN_LIMIT);

  // 2. Seeds.
  t = performance.now();
  // Linked C++ declarations and definitions (T24.3): one logical target for seeds and the Packet.
  const groups = callableGroups(options.graph);
  const seeds = resolveSeeds(valid.value.task, truth, options.graph, request.explicitSeeds ?? [], groups);
  time.seedMs = performance.now() - t;
  const resolution = { seeds: seeds.seeds, ambiguities: seeds.ambiguities, unresolvedIds: seeds.unresolvedIds };
  const idSignals: KnowledgeSignal[] = seeds.unresolvedIds.length > 0 ? [{ kind: "unresolved-id", ids: seeds.unresolvedIds }] : [];
  if (seeds.ambiguities.length > 0) return idle("ambiguous", idSignals, { resolution });
  if (seeds.weighted.length === 0) return idle("insufficient-context", [{ kind: "no-seed" }, ...idSignals], { resolution });

  // 3. Traversal, 4. candidates and ranking (with source retrieval).
  const limits = { maxDepth: Math.min(truth.config.context.maxDepth, 3), nodeLimit: options.nodeLimit ?? DEFAULT_LIMITS.nodeLimit, edgeLimit: DEFAULT_LIMITS.edgeLimit };
  t = performance.now();
  const expansion = expandCandidates(options.graph, seeds.weighted, limits);
  time.traversalMs = performance.now() - t;
  const reader = new SourceReader(root);
  t = performance.now();
  const plan = planContext({
    truth, task: valid.value.task, seeds, expansion, reader,
    callables: { group: (id) => groups.groups.get(id), node: (id) => groups.nodes.get(id) },
  });
  time.retrievalMs = reader.ms;
  time.rankingMs = performance.now() - t - reader.ms;
  diagnostics.push(...plan.diagnostics);

  // 5. Digest, cache, packing.
  const packetRequest = { task: quoted.text, taskTruncated: quoted.truncated, budget, profile };
  const dependencyDigest = packetDependencyDigest({ request: packetRequest, limits, seeds: seeds.seeds, plan });
  const meter = new TokenMeter();
  let packet: ContextPacket | undefined = useCache ? readCachedPacket(root, dependencyDigest) : undefined;
  const hit = packet !== undefined;
  let written = false;
  if (packet === undefined) {
    t = performance.now();
    const packed = packContext({ plan, request: packetRequest, seeds: seeds.seeds, dependencyDigest, meter });
    time.packingMs = performance.now() - t - meter.ms;
    time.tokenizationMs = meter.ms;
    diagnostics.push(...packed.diagnostics);
    if (packed.value === undefined) return failure(canonicalDiagnostics(diagnostics));
    packet = packed.value;
    if (useCache) written = writeCachedPacket(root, packet);
  }

  // 6. Request-level metrics (outside the Packet).
  t = performance.now();
  const before = meter.ms;
  const repo = repositoryTokens(root, meter, useCache, options.tokenCounts);
  const considered = new Set(plan.items.map((i) => i.file));
  const loadedFiles = new Set([...packet.intent.requirements, ...packet.intent.constraints, ...packet.decisions.active, ...packet.code, ...packet.tests, ...packet.issues]
    .filter((i) => i.level !== "L1").map((i) => i.source?.path ?? i.ref));
  const rawCandidateTokens = [...considered].reduce((n, f) => n + (repo.perFile.get(f) ?? 0), 0);
  time.tokenizationMs += meter.ms - before;
  time.metricsMs = performance.now() - t - (meter.ms - before);
  const metrics: ContextMetrics = {
    estimator: TOKEN_ESTIMATOR.name,
    repository: { files: repo.files, tokens: repo.tokens, bytes: repo.bytes, chars: repo.chars, binaryFiles: repo.binaryFiles },
    filesConsidered: considered.size,
    rawCandidateTokens,
    candidateTokens: packet.metrics.candidateTokens,
    selectedTokens: packet.metrics.selectedTokens,
    budget,
    filesLoaded: loadedFiles.size,
    reduction: { vsRepository: reduction(packet.metrics.selectedTokens, repo.tokens), vsRawCandidates: reduction(packet.metrics.selectedTokens, rawCandidateTokens) },
    llmCalls: 0,
  };
  const canonical = canonicalDiagnostics(diagnostics);
  return success({
    status: "ready", packet, resolution, freshness, signals: packet.signals, metrics,
    cache: { status: useCache ? (hit ? "hit" : "miss") : "off", written }, performance: perf(), diagnostics: canonical,
  }, canonical);
}
