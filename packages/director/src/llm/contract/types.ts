/**
 * LLMProvider contract (TASK-012A, ADR-012). Deterministic First, LLM Optional: DUO's index,
 * graph, Context Compiler, Knowledge Gap assessment and Decision lifecycle never need a provider,
 * and a missing or failing provider is not an application failure.
 *
 * The contract describes what DUO needs, not any vendor's API: one instruction text, one input
 * text, a text or structured (JSON Schema) output, a purpose for routing and accounting. There is no
 * message list and no chat roles. Credentials are not part of a request; an adapter gets them from
 * its own configuration. Adapters live outside director (integration → director) and director never
 * imports a vendor SDK (lint rule, scripts/boundaries.json "llmVendorSdk").
 */

/** Why DUO asks. Used for routing, limits and metrics; T12A implements no semantic judgement yet. */
export type LLMPurpose = "gap-semantic-assist" | "review-semantic-check";

/** disabled: no provider wanted (project.yaml llm.provider: none). unavailable: wanted but not usable now. */
export type LLMProviderStatus = "disabled" | "configured" | "unavailable";

/** A JSON Schema object (the standard, not a vendor dialect). */
export type LLMJsonSchema = { readonly [key: string]: unknown };

export type LLMOutputSpec =
  | { readonly mode: "text" }
  | { readonly mode: "structured"; readonly name: string; readonly schema: LLMJsonSchema };

export interface LLMRequest {
  readonly purpose: LLMPurpose;
  /** What to do and how to answer. */
  readonly instructions: string;
  /** The material: a small Packet built by DUO, never raw repository files. */
  readonly input: string;
  readonly output: LLMOutputSpec;
  readonly maxOutputTokens?: number;
  /** Cancellation (e.g. an MCP request that was cancelled). */
  readonly signal?: AbortSignal;
}

/** Only values the provider reported. DUO never fills in estimates here (no chars/4, no guesses). */
export interface LLMUsage {
  readonly provider: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly latencyMs?: number;
}

export type LLMFailureCategory =
  | "not-configured" | "unavailable" | "timeout" | "cancelled" | "authentication" | "rate-limit" | "invalid-response" | "provider-error";

export interface LLMFailure {
  readonly category: LLMFailureCategory;
  /** Human-readable, secrets redacted. */
  readonly message: string;
  readonly retryable: boolean;
}

export type LLMOutput =
  | { readonly mode: "text"; readonly text: string }
  | { readonly mode: "structured"; readonly text: string; readonly value: unknown };

export type LLMResponse =
  | { readonly status: "success"; readonly output: LLMOutput; readonly usage: LLMUsage }
  | { readonly status: "failed"; readonly failure: LLMFailure; readonly usage?: LLMUsage };

/**
 * One injected provider. invoke() should resolve, not reject; invokeLLM() still guards against a
 * rejection, a malformed response and cancellation.
 */
export interface LLMProvider {
  readonly id: string;
  status(): LLMProviderStatus;
  invoke(request: LLMRequest): Promise<LLMResponse>;
}
