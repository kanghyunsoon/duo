/**
 * Optional semantic assistance for Review (TASK-013, ADR-008). Runs only after the deterministic
 * review is complete, only when the request allows it and a provider is configured, with at most
 * llm.max_calls_per_review calls (default 1: all candidates in one structured batch; no retry).
 * The input is the deterministic candidates and the exact evidence excerpts DUO already collected,
 * never the repository. The answer may cite only evidence IDs it was given (else invalid-response).
 *
 * Its claims are supplemental: they never change or remove a deterministic claim, never block,
 * never touch Project Truth. semanticAssist.verdict raises PASS to WARN at most.
 */
import { compareUtf8, evidenceId, sha256Text, type Evidence, type EvidenceBasis, type ProjectTruth } from "@duo-director/core";
import { invokeLLM, llmProviderState, type LLMInvocation } from "../llm/contract/invoke.js";
import type { LLMJsonSchema, LLMProvider } from "../llm/contract/types.js";
import { truncateToTokens } from "../tokens/index.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { Alignment, ReviewClaim, SemanticAssist, SemanticClaim, Verdict } from "./types.js";

const ALIGNMENTS: readonly Alignment[] = ["ALIGNED", "PARTIAL", "CONFLICT", "UNKNOWN"];

export function semanticSchema(claimIds: readonly string[]): LLMJsonSchema {
  return {
    type: "object", additionalProperties: false, required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["claim_id", "alignment", "evidence_ids", "reason"],
          properties: {
            claim_id: { type: "string", enum: [...claimIds] },
            alignment: { type: "string", enum: [...ALIGNMENTS] },
            evidence_ids: { type: "array", items: { type: "string" } },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
    },
  };
}

interface Answer { readonly claim_id: string; readonly alignment: Alignment; readonly evidence_ids: readonly string[]; readonly reason: string }

/** Strict shape check of the structured answer (the schema, enforced here too). */
export function validateAnswer(value: unknown, claimIds: ReadonlySet<string>): string | undefined {
  if (typeof value !== "object" || value === null || Object.keys(value).join() !== "claims" || !Array.isArray((value as { claims?: unknown }).claims)) return "expected { claims: [...] }";
  for (const c of (value as { claims: unknown[] }).claims) {
    if (typeof c !== "object" || c === null) return "claim is not an object";
    const keys = Object.keys(c).sort().join();
    if (keys !== "alignment,claim_id,evidence_ids,reason") return `unexpected fields ${keys}`;
    const a = c as Record<string, unknown>;
    if (typeof a.claim_id !== "string" || !claimIds.has(a.claim_id)) return `unknown claim_id ${String(a.claim_id)}`;
    if (typeof a.alignment !== "string" || !ALIGNMENTS.includes(a.alignment as Alignment)) return `bad alignment ${String(a.alignment)}`;
    if (!Array.isArray(a.evidence_ids) || !a.evidence_ids.every((e) => typeof e === "string")) return "evidence_ids must be strings";
    if (typeof a.reason !== "string" || a.reason.length > 500) return "reason must be a string of at most 500 characters";
  }
  return undefined;
}

export interface SemanticInput {
  readonly root: string;
  readonly truth: ProjectTruth;
  readonly claims: readonly ReviewClaim[];
  readonly store: EvidenceStore;
  readonly verdict: Verdict;
  readonly requested: boolean;
  readonly provider?: LLMProvider;
  readonly cache: boolean;
  readonly signal?: AbortSignal;
}

function skipped(candidates: readonly ReviewClaim[], reason: string): SemanticAssist["skippedChecks"] {
  return candidates.map((c) => ({ claimId: c.id, rule: c.rule, reason }));
}

export async function semanticAssist(input: SemanticInput): Promise<{ assist: SemanticAssist; invocation?: LLMInvocation }> {
  const candidates = input.claims.filter((c) => c.semanticCandidate);
  const base = { candidates: candidates.map((c) => c.id), claims: [], evidence: [], calls: 0, cacheHits: 0 };
  if (!input.requested) return { assist: { ...base, status: "not-requested", skippedChecks: skipped(candidates, "llm-not-requested") } };
  if (candidates.length === 0) return { assist: { ...base, status: "no-candidates", skippedChecks: [] } };
  const state = llmProviderState(input.truth.config.llm, input.provider);
  if (state !== "configured") return { assist: { ...base, status: state === "disabled" ? "disabled" : "unavailable", skippedChecks: skipped(candidates, `llm-${state}`) } };
  if (input.truth.config.llm.maxCallsPerReview < 1) return { assist: { ...base, status: "call-cap", skippedChecks: skipped(candidates, "llm-call-cap") } };

  // One batch: every candidate with its evidence excerpts, each excerpt capped so the whole fits llm.max_input_tokens.
  const allowed = [...new Set(candidates.flatMap((c) => c.evidenceIds))].sort(compareUtf8);
  const perExcerpt = Math.max(40, Math.floor(input.truth.config.llm.maxInputTokens / Math.max(1, allowed.length)) - 20);
  const lines: string[] = [];
  for (const c of candidates) lines.push(`CLAIM ${c.id} rule=${c.rule} subject=${c.subject.id}`, `expected: ${c.expected}`, `observed: ${c.observed}`, `evidence: ${c.evidenceIds.join(", ")}`, "");
  for (const id of allowed) {
    const e = input.store.get(id);
    lines.push(`EVIDENCE ${id} [${e?.basis ?? "?"}] ${e?.summary ?? ""}`, truncateToTokens(input.store.excerpt(id) ?? "", perExcerpt).text, "");
  }
  const ids = new Set(candidates.map((c) => c.id));
  const invocation = await invokeLLM(input.provider, {
    purpose: "review-semantic-check",
    instructions: "For each CLAIM, judge whether the changed code agrees with the cited Project Truth. Answer ALIGNED, PARTIAL, CONFLICT or UNKNOWN. Cite only EVIDENCE IDs given here. Say UNKNOWN when the evidence does not decide it.",
    input: lines.join("\n"),
    output: { mode: "structured", name: "review_semantic_check", schema: semanticSchema([...ids]) },
    maxOutputTokens: 1200,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }, {
    validate: (v) => validateAnswer(v, ids),
    evidence: { allowed, cited: (v) => ((v as { claims?: Answer[] }).claims ?? []).flatMap((c) => c.evidence_ids) },
    timeoutMs: input.truth.config.llm.timeoutMs,
    ...(input.cache ? { cache: { root: input.root } } : {}),
  });
  const counts = { calls: invocation.called ? 1 : 0, cacheHits: invocation.cached ? 1 : 0 };
  const r = invocation.response;
  const u = invocation.called ? r.usage : undefined;
  const usage = u === undefined || (u.inputTokens === undefined && u.outputTokens === undefined && u.cachedInputTokens === undefined) ? {} : {
    usage: {
      ...(u.inputTokens === undefined ? {} : { inputTokens: u.inputTokens }), ...(u.outputTokens === undefined ? {} : { outputTokens: u.outputTokens }),
      ...(u.cachedInputTokens === undefined ? {} : { cachedInputTokens: u.cachedInputTokens }),
    },
  };
  const cacheIdentity = input.provider?.cacheIdentity?.();
  const provider = (model: string | undefined) => ({
    id: input.provider?.id ?? "unknown", ...(model === undefined ? {} : { model }), ...(cacheIdentity === undefined ? {} : { cacheIdentity }),
  });
  if (r.status !== "success" || r.output.mode !== "structured") {
    const failure = r.status === "failed" ? r.failure.category : "invalid-response";
    return { assist: { ...base, ...counts, ...usage, status: "failed", failure, provider: provider(r.usage?.model), skippedChecks: skipped(candidates, `llm-${failure}`) }, invocation };
  }
  const llm: Evidence = {
    id: evidenceId("llm", "llm", sha256Text(r.output.text)), basis: "llm", kind: "llm", contentHash: sha256Text(r.output.text),
    summary: `${r.usage.provider}${r.usage.model === undefined ? "" : ` ${r.usage.model}`} review-semantic-check`, pointer: { kind: "llm" },
  };
  const answers = ((r.output.value as { claims: Answer[] }).claims).slice().sort((a, b) => compareUtf8(a.claim_id, b.claim_id));
  const claims: SemanticClaim[] = answers.map((a) => {
    const bases = new Set<EvidenceBasis>(["llm", ...a.evidence_ids.flatMap((id) => input.store.get(id)?.basis ?? [])]);
    return {
      claimId: a.claim_id, alignment: a.alignment, evidenceIds: [...new Set([...a.evidence_ids, llm.id])].sort(compareUtf8),
      basis: (["project-truth", "repository", "git", "test", "llm"] as const).filter((b) => bases.has(b)), reason: a.reason, blockEligible: false,
    };
  });
  const raised = input.verdict === "PASS" && claims.some((c) => c.alignment === "CONFLICT" || c.alignment === "PARTIAL") ? "WARN" : input.verdict;
  const answered = new Set(claims.map((c) => c.claimId));
  return {
    assist: {
      ...base, ...counts, ...usage, status: "success", provider: provider(r.usage.model), claims, evidence: [llm], verdict: raised,
      skippedChecks: skipped(candidates.filter((c) => !answered.has(c.id)), "llm-no-answer"),
    },
    invocation,
  };
}
