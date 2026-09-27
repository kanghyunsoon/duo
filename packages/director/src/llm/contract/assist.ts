/**
 * Deterministic finding first, optional semantic assistance second (TASK-012A, ADR-008). The
 * deterministic result is returned as it was, whatever the provider does; the assistance is an
 * additional interpretation next to it. Nothing here writes Project Truth or confirms a Decision.
 */
import { invokeLLM, type InvokeOptions, type LLMInvocation } from "./invoke.js";
import type { LLMFailureCategory, LLMOutput, LLMProvider, LLMRequest, LLMUsage } from "./types.js";

export type SemanticAssistance =
  | { readonly status: "not-requested" }
  | { readonly status: "unavailable" | "failed"; readonly category: LLMFailureCategory }
  | { readonly status: "success"; readonly output: LLMOutput; readonly usage: LLMUsage };

export interface Assisted<T> {
  /** Always the deterministic result, unchanged. */
  readonly deterministic: T;
  readonly assistance: SemanticAssistance;
  readonly invocation?: LLMInvocation;
}

const UNAVAILABLE: ReadonlySet<LLMFailureCategory> = new Set(["not-configured", "unavailable"]);

export async function assistDeterministic<T>(deterministic: T, provider: LLMProvider | undefined, request: LLMRequest | undefined, options: InvokeOptions = {}): Promise<Assisted<T>> {
  if (request === undefined) return { deterministic, assistance: { status: "not-requested" } };
  const invocation = await invokeLLM(provider, request, options);
  const r = invocation.response;
  const assistance: SemanticAssistance = r.status === "success"
    ? { status: "success", output: r.output, usage: r.usage }
    : { status: UNAVAILABLE.has(r.failure.category) ? "unavailable" : "failed", category: r.failure.category };
  return { deterministic, assistance, invocation };
}
