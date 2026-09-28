/**
 * Opt-in real call (T12B): one tiny text request and one strict structured request through the
 * configured OpenAIResponsesProvider. It sends no repository content. Skipped unless
 * DUO_OPENAI_SMOKE=1, OPENAI_API_KEY and DUO_OPENAI_SMOKE_MODEL (an explicit model ID) are set.
 */
import { createConfiguredLLMProvider } from "@duo-director/integration";
import { describe, expect, it } from "vitest";

const model = process.env.DUO_OPENAI_SMOKE_MODEL ?? "";
const enabled = process.env.DUO_OPENAI_SMOKE === "1" && (process.env.OPENAI_API_KEY ?? "") !== "" && model !== "";

describe.skipIf(!enabled)("OpenAI Responses smoke (opt-in)", () => {
  const llm = { provider: "openai-responses" as const, model, apiKeyEnv: "OPENAI_API_KEY", baseUrl: null, maxCallsPerReview: 1, maxInputTokens: 4000, timeoutMs: 60_000, cache: false };

  it("text and strict structured output, provider-reported usage", async () => {
    const { provider, status } = createConfiguredLLMProvider(llm, process.env);
    expect(status).toBe("configured");
    const signal = AbortSignal.timeout(60_000);
    const text = await provider.invoke({ purpose: "review-semantic-check", instructions: "Answer with the single word: ready", input: "ping", output: { mode: "text" }, maxOutputTokens: 200, signal });
    expect(text.status, JSON.stringify(text)).toBe("success");
    const schema = { type: "object", additionalProperties: false, required: ["answer", "evidence_ids"], properties: { answer: { type: "string", enum: ["ALIGNED", "UNKNOWN"] }, evidence_ids: { type: "array", items: { type: "string" } } } };
    const structured = await provider.invoke({
      purpose: "review-semantic-check", instructions: "Answer ALIGNED and cite evidence ev-1 only.", input: "EVIDENCE ev-1: the code matches.",
      output: { mode: "structured", name: "smoke", schema }, maxOutputTokens: 400, signal,
    });
    expect(structured.status, JSON.stringify(structured)).toBe("success");
    if (structured.status !== "success" || structured.output.mode !== "structured") return;
    const value = structured.output.value as { answer: string; evidence_ids: string[] };
    expect(["ALIGNED", "UNKNOWN"]).toContain(value.answer);
    expect(value.evidence_ids.every((id) => id === "ev-1")).toBe(true);
    expect(structured.usage.provider).toBe("openai-responses");
    expect(typeof structured.usage.inputTokens).toBe("number");
  });
});
