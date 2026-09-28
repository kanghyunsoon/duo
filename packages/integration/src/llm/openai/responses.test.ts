import { invokeLLM, type LLMRequest } from "@duo-director/director";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredLLMProvider, LLMProviderPool } from "../factory.js";
import { createOpenAIResponsesProvider, failureOf, OPENAI_OFFICIAL_BASE_URL, toStrictSchema, type ResponsesClient } from "./responses.js";

const KEY = "sk-test-SECRET-0123456789abcdef";

interface Call { readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }

/** A fake transport for the real SDK: records requests, answers with the given status and JSON. */
function fakeFetch(answer: (call: Call, signal?: AbortSignal | null) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return answer(call, init?.signal);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function responseBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-test-2026-01-01",
    output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 },
    ...extra,
  };
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["answer"],
  properties: { answer: { type: "string", maxLength: 50 } },
};
const textRequest: LLMRequest = { purpose: "review-semantic-check", instructions: "Say hi.", input: "EVIDENCE ev-1", output: { mode: "text" }, maxOutputTokens: 64 };
const structured: LLMRequest = { ...textRequest, output: { mode: "structured", name: "check", schema: SCHEMA } };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("OpenAIResponsesProvider request (T12B)", () => {
  it("calls only the official Responses endpoint, stateless, store false, no tools, strict json_schema; the environment does not redirect it", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example.invalid/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    vi.stubEnv("OPENAI_LOG", "debug");
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const t = fakeFetch(() => json(200, responseBody(JSON.stringify({ answer: "ok" }))));
    const provider = createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: t.fetchImpl });
    const r = await provider.invoke(structured);
    expect(r).toMatchObject({ status: "success", output: { mode: "structured", value: { answer: "ok" } } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe(`${OPENAI_OFFICIAL_BASE_URL}/responses`);
    expect(t.calls[0]?.body).toEqual({
      model: "gpt-test", instructions: "Say hi.", input: "EVIDENCE ev-1", store: false, max_output_tokens: 64,
      text: { format: { type: "json_schema", name: "check", strict: true, schema: { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } } } },
    });
    for (const k of ["tools", "previous_response_id", "conversation", "background", "stream"]) expect(t.calls[0]?.body).not.toHaveProperty(k);
    expect(t.calls[0]?.headers.get("openai-organization")).toBeNull();
    expect(t.calls[0]?.headers.get("openai-project")).toBeNull();
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("maps text output, the provider-reported usage and the model the response names", async () => {
    const t = fakeFetch(() => json(200, responseBody("hello")));
    const r = await createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: t.fetchImpl }).invoke(textRequest);
    expect(r).toEqual({
      status: "success", output: { mode: "text", text: "hello" },
      usage: { provider: "openai-responses", model: "gpt-test-2026-01-01", inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
    });
    const bare = fakeFetch(() => json(200, { ...responseBody("hello"), usage: null }));
    const b = await createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: bare.fetchImpl }).invoke(textRequest);
    expect(b.status === "success" ? b.usage : undefined).toEqual({ provider: "openai-responses", model: "gpt-test-2026-01-01" }); // nothing estimated
  });

  it("drops only the keywords strict mode rejects from the schema", () => {
    expect(toStrictSchema({ type: "array", items: { type: "string", minLength: 1, maxLength: 3, enum: ["a"] } })).toEqual({ type: "array", items: { type: "string", enum: ["a"] } });
  });
});

describe("OpenAIResponsesProvider failures (T12B)", () => {
  it.each([
    [401, "authentication", false], [403, "authentication", false], [429, "rate-limit", true],
    [400, "provider-error", false], [404, "provider-error", false], [422, "provider-error", false],
    [500, "unavailable", true], [503, "unavailable", true],
  ] as const)("HTTP %i → %s (retryable %s), one attempt, no secret in the message", async (status, category, retryable) => {
    const leak = { error: { message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}`, type: "invalid_request_error", code: "x" } };
    const t = fakeFetch(() => json(status, leak));
    const r = await createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: t.fetchImpl }).invoke(structured);
    expect(r).toMatchObject({ status: "failed", failure: { category, retryable } });
    expect(t.calls).toHaveLength(1); // maxRetries 0: the SDK does not retry 429 / 5xx
    const text = JSON.stringify(r);
    for (const secret of [KEY, "Bearer", "Authorization", "Incorrect API key"]) expect(text).not.toContain(secret);
  });

  it("network failure → unavailable; the error text (with a header) is not copied", async () => {
    const t = fakeFetch(() => { throw new TypeError(`fetch failed: Authorization: Bearer ${KEY}`); });
    const r = await createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: t.fetchImpl }).invoke(textRequest);
    expect(r).toMatchObject({ status: "failed", failure: { category: "unavailable", retryable: true } });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("SDK error classes: connection timeout, user abort, connection error; any other exception is provider-error without its message", () => {
    expect(failureOf(new OpenAI.APIConnectionTimeoutError())).toMatchObject({ failure: { category: "timeout" } });
    expect(failureOf(new OpenAI.APIUserAbortError())).toMatchObject({ failure: { category: "cancelled" } });
    expect(failureOf(new OpenAI.APIConnectionError({ message: `x ${KEY}` }))).toMatchObject({ failure: { category: "unavailable" } });
    const custom = failureOf(new Error(`boom Authorization: Bearer ${KEY}`));
    expect(custom).toMatchObject({ failure: { category: "provider-error", retryable: false } });
    expect(JSON.stringify(custom)).not.toContain(KEY);
  });

  it("DUO's timeout and the caller's cancellation (invokeLLM) end a request that does not answer", async () => {
    const hang = fakeFetch((_c, signal) => new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const provider = createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: hang.fetchImpl });
    const timed = await invokeLLM(provider, textRequest, { timeoutMs: 50 });
    expect(timed.response).toMatchObject({ status: "failed", failure: { category: "timeout" } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = await invokeLLM(provider, { ...textRequest, signal: controller.signal });
    expect(cancelled.response).toMatchObject({ status: "failed", failure: { category: "cancelled" } });
  });

  it.each([
    ["incomplete", responseBody("{\"answer\":", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })],
    ["refusal", { ...responseBody("RAWMODELTEXT"), output: [{ type: "message", id: "m", status: "completed", role: "assistant", content: [{ type: "refusal", refusal: "RAWMODELTEXT" }] }] }],
    ["empty", responseBody("   ")],
    ["not JSON", responseBody("RAWMODELTEXT not json")],
  ])("a successful HTTP answer that is %s → invalid-response, model text not quoted", async (_n, body) => {
    const t = fakeFetch(() => json(200, body));
    const r = await createOpenAIResponsesProvider({ model: "gpt-test", apiKey: KEY, fetch: t.fetchImpl }).invoke(structured);
    expect(r).toMatchObject({ status: "failed", failure: { category: "invalid-response", retryable: false } });
    expect(JSON.stringify(r.status === "failed" ? r.failure : {})).not.toContain("RAWMODELTEXT");
  });

  it("schema mismatch and unknown evidence stay DUO's checks (invokeLLM) → invalid-response", async () => {
    const client: ResponsesClient = { create: () => Promise.resolve(responseBody(JSON.stringify({ answer: "x", cites: ["ev-999"] }))) };
    const provider = createOpenAIResponsesProvider({ model: "gpt-test", client });
    const shape = await invokeLLM(provider, structured, { validate: (v) => (Object.keys(v as object).join() === "answer" ? undefined : "unexpected fields") });
    expect(shape.response).toMatchObject({ status: "failed", failure: { category: "invalid-response" } });
    const evidence = await invokeLLM(provider, structured, { evidence: { allowed: ["ev-1"], cited: (v) => (v as { cites: string[] }).cites } });
    expect(evidence.response).toMatchObject({ status: "failed", failure: { category: "invalid-response" } });
  });
});

describe("cache identity and status (T12B)", () => {
  it("identity names provider, endpoint family, adapter, structured policy and model; never the key", () => {
    const a = createOpenAIResponsesProvider({ model: "gpt-a", apiKey: KEY }).cacheIdentity?.();
    const b = createOpenAIResponsesProvider({ model: "gpt-b", apiKey: KEY }).cacheIdentity?.();
    expect(a).toBe("openai-responses;endpoint=responses;base=official;adapter=1;structured=strict-1;model=gpt-a");
    expect(a).not.toBe(b);
    expect(a).not.toContain(KEY);
    expect(createOpenAIResponsesProvider({ model: "gpt-a" }).status()).toBe("unavailable");
  });
});

const llm = (over: Partial<Parameters<typeof createConfiguredLLMProvider>[0]> = {}) => ({
  provider: "openai-responses" as const, model: "gpt-test", apiKeyEnv: "OPENAI_API_KEY", baseUrl: null, maxCallsPerReview: 1, maxInputTokens: 4000, timeoutMs: 30000, cache: true, ...over,
});

describe("provider factory (T12B)", () => {
  it("is explicit: provider none is disabled even with a key in the environment", () => {
    const c = createConfiguredLLMProvider(llm({ provider: "none" }), { OPENAI_API_KEY: KEY });
    expect(c).toMatchObject({ status: "disabled", kind: "none", provider: { id: "noop" } });
  });

  it.each([
    ["no model", llm({ model: null }), { OPENAI_API_KEY: KEY }, /llm\.model is not set/u],
    ["blank model", llm({ model: "  " }), { OPENAI_API_KEY: KEY }, /llm\.model is not set/u],
    ["no key", llm(), {}, /OPENAI_API_KEY is not set/u],
    ["custom key variable unset", llm({ apiKeyEnv: "DUO_OPENAI_KEY" }), { OPENAI_API_KEY: KEY }, /DUO_OPENAI_KEY is not set/u],
    ["llm.base_url", llm({ baseUrl: "https://proxy.example.invalid/v1" }), { OPENAI_API_KEY: KEY }, /base_url is not supported/u],
    ["OPENAI_BASE_URL", llm(), { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "https://proxy.example.invalid/v1" }, /OPENAI_BASE_URL points elsewhere/u],
    ["OPENAI_CUSTOM_HEADERS", llm(), { OPENAI_API_KEY: KEY, OPENAI_CUSTOM_HEADERS: "x-route: a" }, /OPENAI_CUSTOM_HEADERS is set/u],
  ])("%s → unavailable with a reason and no secret", async (_n, config, env, reason) => {
    const c = createConfiguredLLMProvider(config, env);
    expect(c.status).toBe("unavailable");
    expect(c.reason).toMatch(reason);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(c.provider.status()).toBe("unavailable");
    expect((await invokeLLM(c.provider, textRequest)).called).toBe(false);
  });

  it("configured with a model and a key; the official endpoint spelled out is accepted", () => {
    expect(createConfiguredLLMProvider(llm(), { OPENAI_API_KEY: KEY })).toMatchObject({ status: "configured", model: "gpt-test" });
    expect(createConfiguredLLMProvider(llm({ baseUrl: `${OPENAI_OFFICIAL_BASE_URL}/` }), { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: OPENAI_OFFICIAL_BASE_URL }).status).toBe("configured");
    expect(createConfiguredLLMProvider(llm({ apiKeyEnv: "DUO_OPENAI_KEY" }), { DUO_OPENAI_KEY: KEY }).status).toBe("configured");
  });

  it("a pool snapshots the environment once and reuses the provider per configuration", () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: KEY };
    const pool = new LLMProviderPool(env);
    const first = pool.forConfig(llm());
    delete env.OPENAI_API_KEY;
    expect(pool.forConfig(llm())).toBe(first);
    expect(pool.forConfig(llm()).status).toBe("configured");
    expect(pool.forConfig(llm({ model: "gpt-other" }))).not.toBe(first);
    expect(new LLMProviderPool(env).forConfig(llm()).status).toBe("unavailable");
  });
});
