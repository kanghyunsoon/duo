/**
 * The default provider (ADR-012 NoneProvider, TASK-012A): never configured, answers every call
 * with not-configured. It performs no I/O at all: no network, no environment variables, no files.
 */
import type { LLMProvider, LLMResponse } from "../contract/types.js";

export const NOOP_LLM_PROVIDER_ID = "noop";

export function createNoopLLMProvider(): LLMProvider {
  return {
    id: NOOP_LLM_PROVIDER_ID,
    status: () => "disabled",
    invoke: (): Promise<LLMResponse> => Promise.resolve({
      status: "failed", failure: { category: "not-configured", message: "LLM is disabled (llm.provider: none)", retryable: false },
    }),
  };
}
