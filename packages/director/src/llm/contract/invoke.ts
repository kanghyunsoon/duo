/**
 * Safe invocation (TASK-012A): the only way DUO code calls a provider. It never throws, checks
 * status and cancellation before calling, turns a rejection or a malformed answer into a
 * categorized failure, validates structured output (shape and cited evidence IDs) and redacts
 * secrets from failure messages. A failed or unavailable call leaves every deterministic result as
 * it was: see assistDeterministic().
 */
import { performance } from "node:perf_hooks";
import { redactSecrets } from "../../context/redact.js";
import { countTokens, TOKEN_ESTIMATOR } from "../../tokens/index.js";
import type { LLMFailureCategory, LLMProvider, LLMProviderStatus, LLMRequest, LLMResponse } from "./types.js";

export interface InvokeOptions {
  /** Structured output check: a problem description, or undefined when the value is acceptable. */
  readonly validate?: (value: unknown) => string | undefined;
  /** Evidence citation check (ADR-008): cited IDs must all be among the IDs DUO sent. */
  readonly evidence?: { readonly allowed: readonly string[]; readonly cited: (value: unknown) => readonly string[] };
}

export interface LLMInvocation {
  readonly purpose: LLMRequest["purpose"];
  readonly provider: string;
  /** False when DUO did not call the provider at all (not configured, cancelled before start). */
  readonly called: boolean;
  readonly response: LLMResponse;
  /** DUO's own measurement of the text it sent (not provider usage). */
  readonly requestEstimate: { readonly tokens: number; readonly estimator: typeof TOKEN_ESTIMATOR.name };
  /** Wall clock around the call, measured by DUO. */
  readonly elapsedMs: number;
}

function failed(category: LLMFailureCategory, message: string, retryable = false): LLMResponse {
  return { status: "failed", failure: { category, message: redactSecrets(message).text, retryable } };
}

function isResponse(x: unknown): x is LLMResponse {
  if (typeof x !== "object" || x === null) return false;
  const r = x as { status?: unknown; output?: { mode?: unknown; text?: unknown }; failure?: { category?: unknown; message?: unknown }; usage?: { provider?: unknown } };
  if (r.status === "success") return typeof r.output?.text === "string" && (r.output.mode === "text" || r.output.mode === "structured") && typeof r.usage?.provider === "string";
  if (r.status === "failed") return typeof r.failure?.category === "string" && typeof r.failure.message === "string";
  return false;
}

/** disabled when project.yaml turns LLM off; unavailable when it asks for a provider that is not injected. */
export function llmProviderState(config: { readonly provider: string }, provider?: LLMProvider): LLMProviderStatus {
  if (config.provider === "none") return "disabled";
  return provider === undefined ? "unavailable" : provider.status();
}

export async function invokeLLM(provider: LLMProvider | undefined, request: LLMRequest, options: InvokeOptions = {}): Promise<LLMInvocation> {
  const t0 = performance.now();
  // A function, not a value: the signal can fire while the provider is running.
  const aborted = (): boolean => request.signal?.aborted === true;
  const requestEstimate = { tokens: countTokens(request.instructions) + countTokens(request.input), estimator: TOKEN_ESTIMATOR.name };
  const done = (response: LLMResponse, called: boolean): LLMInvocation => ({
    purpose: request.purpose, provider: provider?.id ?? "none", called, response: sanitize(response), requestEstimate,
    elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
  });
  if (provider === undefined) return done(failed("not-configured", "no LLM provider is configured"), false);
  const status = provider.status();
  if (status === "disabled") return done(failed("not-configured", `LLM provider ${provider.id} is disabled`), false);
  if (status === "unavailable") return done(failed("unavailable", `LLM provider ${provider.id} is unavailable`, true), false);
  if (aborted()) return done(failed("cancelled", "the request was cancelled before it started"), false);

  let raw: unknown;
  try {
    raw = await provider.invoke(request);
  } catch (error) {
    if (aborted()) return done(failed("cancelled", "the request was cancelled"), true);
    return done(failed("provider-error", `provider ${provider.id} threw: ${error instanceof Error ? error.message : String(error)}`), true);
  }
  if (aborted()) return done(failed("cancelled", "the request was cancelled"), true);
  if (!isResponse(raw)) return done(failed("invalid-response", `provider ${provider.id} returned a malformed response`), true);
  if (raw.status === "failed") return done(raw, true);
  if (raw.output.mode !== request.output.mode) return done(failed("invalid-response", `expected ${request.output.mode} output, got ${raw.output.mode}`), true);
  if (raw.output.mode === "structured") {
    const problem = options.validate?.(raw.output.value);
    if (problem !== undefined) return done(failed("invalid-response", `structured output rejected: ${problem}`), true);
    if (options.evidence !== undefined) {
      const allowed = new Set(options.evidence.allowed);
      const unknown = options.evidence.cited(raw.output.value).filter((id) => !allowed.has(id));
      if (unknown.length > 0) return done(failed("invalid-response", `cites evidence that was not provided: ${[...new Set(unknown)].sort().join(", ")}`), true);
    }
  }
  return done(raw, true);
}

function sanitize(response: LLMResponse): LLMResponse {
  return response.status === "failed" ? { ...response, failure: { ...response.failure, message: redactSecrets(response.failure.message).text } } : response;
}

/** One runtime/metrics.jsonl record for an LLM invocation (REQ-LLM-004). Writing it is the caller's job (C83). */
export interface LLMUsageRecord {
  readonly kind: "llm";
  readonly purpose: LLMRequest["purpose"];
  readonly provider: string;
  readonly model?: string;
  readonly called: boolean;
  readonly status: "success" | "failed";
  readonly category?: LLMFailureCategory;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly providerLatencyMs?: number;
  /** "provider" when the provider reported usage, "none" otherwise. Never estimated. */
  readonly tokenSource: "provider" | "none";
  readonly requestEstimate: LLMInvocation["requestEstimate"];
  readonly elapsedMs: number;
}

export function llmUsageRecord(invocation: LLMInvocation): LLMUsageRecord {
  const r = invocation.response;
  const u = r.usage;
  const reported = u !== undefined && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.cachedInputTokens !== undefined);
  return {
    kind: "llm", purpose: invocation.purpose, provider: u?.provider ?? invocation.provider, ...(u?.model === undefined ? {} : { model: u.model }),
    called: invocation.called, status: r.status, ...(r.status === "failed" ? { category: r.failure.category } : {}),
    ...(u?.inputTokens === undefined ? {} : { inputTokens: u.inputTokens }), ...(u?.outputTokens === undefined ? {} : { outputTokens: u.outputTokens }),
    ...(u?.cachedInputTokens === undefined ? {} : { cachedInputTokens: u.cachedInputTokens }), ...(u?.latencyMs === undefined ? {} : { providerLatencyMs: u.latencyMs }),
    tokenSource: reported ? "provider" : "none", requestEstimate: invocation.requestEstimate, elapsedMs: invocation.elapsedMs,
  };
}
