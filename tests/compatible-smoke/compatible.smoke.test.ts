/**
 * Opt-in live check of the openai-compatible provider (T27.1, H-60) against an endpoint the user names. Generic: any
 * OpenAI-compatible endpoint (GMS is one use case); no endpoint-specific code. Skipped, with no network, unless every
 * setting is given in the environment:
 *
 *   DUO_COMPATIBLE_SMOKE=1
 *   DUO_COMPATIBLE_SMOKE_BASE_URL=<https URL or loopback http>
 *   DUO_COMPATIBLE_SMOKE_MODEL=<model ID>
 *   DUO_COMPATIBLE_SMOKE_TRANSPORT=responses|chat-completions
 *   DUO_COMPATIBLE_SMOKE_STRUCTURED_OUTPUT=json-schema|json-object|prompt-only
 *   DUO_COMPATIBLE_SMOKE_API_KEY_ENV=<name of the environment variable that holds the key>
 *
 * The key is read from that variable only (never a command-line argument). One structured request without repository
 * content, validated by DUO. It prints the provider kind, the endpoint origin, transport, output mode, model and the
 * result category; never the key, headers, the full URL, the request or the answer. Never in CI, never a release gate.
 */
import { parseCompatibleBaseUrl } from "@duo-director/core";
import { invokeLLM } from "@duo-director/director";
import { createConfiguredLLMProvider } from "@duo-director/integration";
import { describe, expect, it } from "vitest";

const env = process.env;
const setting = (name: string) => (env[`DUO_COMPATIBLE_SMOKE_${name}`] ?? "").trim();
const keyEnv = setting("API_KEY_ENV");
const enabled = env.DUO_COMPATIBLE_SMOKE === "1" && ["BASE_URL", "MODEL", "TRANSPORT", "STRUCTURED_OUTPUT"].every((n) => setting(n) !== "") && keyEnv !== "" && (env[keyEnv] ?? "") !== "";

describe.skipIf(!enabled)("openai-compatible live smoke (opt-in)", () => {
  it("one structured request through the configured endpoint, validated by DUO", async () => {
    const endpoint = parseCompatibleBaseUrl(setting("BASE_URL"));
    expect(endpoint.problem, "DUO_COMPATIBLE_SMOKE_BASE_URL is refused by the endpoint policy").toBeUndefined();
    const transport = setting("TRANSPORT") as "responses" | "chat-completions";
    const structuredOutput = setting("STRUCTURED_OUTPUT") as "json-schema" | "json-object" | "prompt-only";
    expect(["responses", "chat-completions"]).toContain(transport);
    expect(["json-schema", "json-object", "prompt-only"]).toContain(structuredOutput);
    const configured = createConfiguredLLMProvider({
      provider: "openai-compatible", model: setting("MODEL"), apiKeyEnv: keyEnv, baseUrl: setting("BASE_URL"), transport, structuredOutput,
      maxCallsPerReview: 1, maxInputTokens: 4000, timeoutMs: 60_000, cache: false,
    }, env);
    expect(configured.status).toBe("configured");
    const schema = { type: "object", additionalProperties: false, required: ["answer", "evidence_ids"], properties: { answer: { type: "string", enum: ["ALIGNED", "UNKNOWN"] }, evidence_ids: { type: "array", items: { type: "string" } } } };
    const inv = await invokeLLM(configured.provider, {
      purpose: "review-semantic-check", instructions: "Answer ALIGNED and cite evidence ev-1 only.", input: "EVIDENCE ev-1: the code matches.",
      output: { mode: "structured", name: "smoke", schema }, maxOutputTokens: 400,
    }, {
      timeoutMs: 60_000,
      validate: (v) => (typeof v === "object" && v !== null && ["ALIGNED", "UNKNOWN"].includes(String((v as { answer?: unknown }).answer)) ? undefined : "expected { answer, evidence_ids }"),
      evidence: { allowed: ["ev-1"], cited: (v) => ((v as { evidence_ids?: string[] }).evidence_ids ?? []) },
    });
    const r = inv.response;
    console.log(JSON.stringify({
      provider: configured.kind, origin: endpoint.value?.origin, transport, structuredOutput, model: setting("MODEL"),
      result: r.status === "success" ? "success" : r.failure.category,
    }));
    expect(r.status === "success" ? "success" : r.failure.category).toBe("success");
  });
});
