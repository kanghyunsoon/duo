import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { invokeLLM, type LLMRequest } from "@duo-director/director";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredLLMProvider } from "../factory.js";
import { compatibleClientSettings, createOpenAICompatibleProvider, type CompatibleTransport, type StructuredOutputMode } from "./provider.js";

const KEY = "gms-test-KEY-0123456789abcdef";
const OPENAI_SECRET = "sk-proj-DUOCOMPATCANARY0123456789abcdef";
const AWS_SECRET = "AKIADUOCOMPATCANARY1";
const BASE = "https://gateway.example/proxy/openai/v1";

interface Call { readonly url: string; readonly authorized: boolean; readonly redirect: string | undefined; readonly body: Record<string, unknown>; readonly headers: Headers }

/** A fake transport for the real SDK. The Authorization header is only compared, never kept. */
function fakeFetch(answer: (call: Call, signal?: AbortSignal | null) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: String(input instanceof Request ? input.url : input), authorized: headers.get("authorization") === `Bearer ${KEY}`, redirect: init?.redirect, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers };
    headers.delete("authorization");
    calls.push(call);
    return answer(call, init?.signal);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const responsesAnswer = (text: string) => ({ id: "r1", object: "response", status: "completed", model: "m-served", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } });
const chatAnswer = (content: unknown, extra: Record<string, unknown> = {}) => ({ id: "c1", object: "chat.completion", model: "m-served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...extra } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } });
const answerFor = (transport: CompatibleTransport, text: string) => (transport === "responses" ? responsesAnswer(text) : chatAnswer(text));

const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", maxLength: 50 } } };
const structured: LLMRequest = { purpose: "review-semantic-check", instructions: "Judge it.", input: "EVIDENCE ev-1", output: { mode: "structured", name: "check", schema: SCHEMA }, maxOutputTokens: 64 };
const validate = (v: unknown) => (typeof v === "object" && v !== null && typeof (v as { answer?: unknown }).answer === "string" && Object.keys(v).join() === "answer" ? undefined : "expected { answer }");

const provider = (transport: CompatibleTransport, mode: StructuredOutputMode, fetchImpl: typeof fetch, over: { baseUrl?: string; model?: string } = {}) =>
  createOpenAICompatibleProvider({ baseUrl: over.baseUrl ?? BASE, origin: "https://gateway.example", transport, structuredOutput: mode, model: over.model ?? "m-1", apiKey: KEY, fetch: fetchImpl });
const llmConfig = (over: Record<string, unknown> = {}) => ({
  provider: "openai-compatible" as const, model: "m-1", apiKeyEnv: "GMS_API_KEY", baseUrl: BASE, transport: "chat-completions" as const, structuredOutput: "prompt-only" as const,
  maxCallsPerReview: 1, maxInputTokens: 4000, timeoutMs: 30000, cache: true, ...over,
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("OpenAICompatibleProvider requests (T27.1)", () => {
  const MATRIX: [CompatibleTransport, StructuredOutputMode][] = [
    ["responses", "json-schema"], ["responses", "json-object"], ["responses", "prompt-only"],
    ["chat-completions", "json-schema"], ["chat-completions", "json-object"], ["chat-completions", "prompt-only"],
  ];

  it("each transport × structured_output sends exactly its own fields, once, to the base URL with its prefix, with the key and without following redirects", async () => {
    for (const [transport, mode] of MATRIX) {
      const t = fakeFetch(() => json(200, answerFor(transport, JSON.stringify({ answer: "ok" }))));
      const r = await provider(transport, mode, t.fetchImpl).invoke(structured);
      const label = `${transport} × ${mode}`;
      expect(r, label).toMatchObject({ status: "success", output: { mode: "structured", value: { answer: "ok" } }, usage: { provider: "openai-compatible", model: "m-served", inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 } });
      expect(t.calls, label).toHaveLength(1);
      const c = t.calls[0] as Call;
      expect(c.url, label).toBe(`${BASE}/${transport === "responses" ? "responses" : "chat/completions"}`);
      expect(c.authorized, label).toBe(true);
      expect(c.redirect, label).toBe("manual");
      expect(c.headers.get("openai-organization"), label).toBeNull();
      for (const k of ["tools", "tool_choice", "functions", "previous_response_id", "conversation", "stream", "n"]) expect(c.body, label).not.toHaveProperty(k);
      const strict = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
      if (transport === "responses") {
        expect(c.body.store, label).toBe(false);
        expect(c.body).toMatchObject({ model: "m-1", input: "EVIDENCE ev-1", max_output_tokens: 64 });
        expect(c.body).not.toHaveProperty("messages");
        expect(c.body).not.toHaveProperty("response_format");
        if (mode === "json-schema") expect(c.body.text, label).toEqual({ format: { type: "json_schema", name: "check", schema: strict, strict: true } });
        else if (mode === "json-object") expect(c.body.text, label).toEqual({ format: { type: "json_object" } });
        else expect(c.body, label).not.toHaveProperty("text");
        expect(String(c.body.instructions).startsWith("Judge it."), label).toBe(true);
        expect(String(c.body.instructions).includes("JSON Schema"), label).toBe(mode !== "json-schema");
      } else {
        expect(c.body).toMatchObject({ model: "m-1", max_tokens: 64 });
        expect(c.body).not.toHaveProperty("store");
        expect(c.body).not.toHaveProperty("text");
        const messages = c.body.messages as { role: string; content: string }[];
        expect(messages.map((m) => m.role), label).toEqual(["system", "user"]);
        expect(messages[1]?.content).toBe("EVIDENCE ev-1");
        expect(messages[0]?.content.startsWith("Judge it."), label).toBe(true);
        expect(messages[0]?.content.includes("JSON Schema"), label).toBe(mode !== "json-schema");
        if (mode === "json-schema") expect(c.body.response_format, label).toEqual({ type: "json_schema", json_schema: { name: "check", schema: strict, strict: true } });
        else if (mode === "json-object") expect(c.body.response_format, label).toEqual({ type: "json_object" });
        else expect(c.body, label).not.toHaveProperty("response_format");
      }
    }
  });

  it("a base URL with or without a trailing / and with a deep prefix keeps the prefix; no /v1/v1, no prefix drop", async () => {
    for (const [base, expected] of [["https://g.example/a/b/v1", "https://g.example/a/b/v1/chat/completions"], ["https://g.example", "https://g.example/chat/completions"], ["https://g.example/v1/", "https://g.example/v1/chat/completions"]] as const) {
      const t = fakeFetch(() => json(200, chatAnswer("{\"answer\":\"ok\"}")));
      const settings = compatibleClientSettings(base, KEY, t.fetchImpl);
      const { default: OpenAI } = await import("openai");
      await new OpenAI(settings).chat.completions.create({ model: "m", messages: [{ role: "user", content: "x" }] });
      expect(t.calls[0]?.url, base).toBe(expected);
    }
  });

  it("DUO's final validation runs in every mode: malformed JSON and schema mismatch fail even when the endpoint accepted a native format", async () => {
    for (const [transport, mode] of MATRIX) {
      for (const [answer, expectedText] of [["not json", "not valid JSON"], [JSON.stringify({ answer: 7 }), "expected { answer }"], [JSON.stringify({ answer: "ok", extra: 1 }), "expected { answer }"]] as const) {
        const t = fakeFetch(() => json(200, answerFor(transport, answer)));
        const inv = await invokeLLM(provider(transport, mode, t.fetchImpl), structured, { validate });
        expect(inv.response, `${transport} × ${mode} ${answer}`).toMatchObject({ status: "failed", failure: { category: "invalid-response" } });
        if (inv.response.status === "failed") expect(inv.response.failure.message).toContain(expectedText);
      }
    }
  });

  it("answers without a usable result are invalid-response: empty, null or non-text content, refusal, truncation, incomplete, no choices, not an object", async () => {
    const cases: [CompatibleTransport, unknown][] = [
      ["chat-completions", chatAnswer(null)], ["chat-completions", chatAnswer("")], ["chat-completions", chatAnswer([{ type: "text", text: "x" }])],
      ["chat-completions", chatAnswer(null, { refusal: "no" })], ["chat-completions", { ...chatAnswer("{}"), choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "{" } }] }],
      ["chat-completions", { id: "c", choices: [] }], ["responses", { ...responsesAnswer("{}"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }],
      ["responses", { ...responsesAnswer(""), output: [] }], ["responses", { ...responsesAnswer("x"), output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }],
    ];
    for (const [transport, body] of cases) {
      const t = fakeFetch(() => json(200, body));
      expect(await provider(transport, "json-object", t.fetchImpl).invoke(structured), JSON.stringify(body)).toMatchObject({ status: "failed", failure: { category: "invalid-response", retryable: false } });
    }
    const text = fakeFetch(() => new Response("plain text, not JSON", { status: 200, headers: { "content-type": "text/plain" } }));
    expect(await provider("chat-completions", "prompt-only", text.fetchImpl).invoke(structured)).toMatchObject({ status: "failed", failure: { category: "invalid-response" } });
  });
});

describe("no fallback, no retry, DUO owns the time limit (T27.1)", () => {
  it("an unsupported json-schema request fails once: no json-object or prompt-only retry, no other transport, no /models", async () => {
    for (const [transport, status] of [["chat-completions", 400], ["responses", 404], ["chat-completions", 404], ["responses", 422]] as const) {
      const t = fakeFetch(() => json(status, { error: { message: "unsupported " + KEY } }));
      const r = await provider(transport, "json-schema", t.fetchImpl).invoke(structured);
      expect(r).toMatchObject({ status: "failed", failure: { category: "provider-error", retryable: false } });
      expect(t.calls.map((c) => new URL(c.url).pathname)).toEqual([`/proxy/openai/v1/${transport === "responses" ? "responses" : "chat/completions"}`]);
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(JSON.stringify(r)).not.toContain("/proxy/openai");
    }
  });

  it("429, 500, 503 and a network error are one request each (the SDK does not retry)", async () => {
    for (const status of [429, 500, 503]) {
      const t = fakeFetch(() => json(status, { error: {} }, { "retry-after": "0" }));
      const r = await provider("chat-completions", "prompt-only", t.fetchImpl).invoke(structured);
      expect(t.calls, String(status)).toHaveLength(1);
      expect(r).toMatchObject({ status: "failed", failure: { category: status === 429 ? "rate-limit" : "unavailable" } });
    }
    let n = 0;
    const down = (() => { n++; return Promise.reject(new TypeError("fetch failed")); }) as typeof fetch;
    expect(await provider("responses", "json-object", down).invoke(structured)).toMatchObject({ status: "failed", failure: { category: "unavailable" } });
    expect(n).toBe(1);
  });

  it("the error taxonomy matches the official provider's categories, with the endpoint's own wording and no URL or key", async () => {
    const expected: [number, string, boolean][] = [[400, "provider-error", false], [401, "authentication", false], [403, "authentication", false], [404, "provider-error", false], [408, "unavailable", true], [429, "rate-limit", true], [500, "unavailable", true], [418, "provider-error", false]];
    for (const [status, category, retryable] of expected) {
      const t = fakeFetch(() => json(status, { error: { message: `bad key ${KEY} at ${BASE}` } }));
      const r = await provider("chat-completions", "json-object", t.fetchImpl).invoke(structured);
      expect(r, String(status)).toEqual({ status: "failed", failure: { category, retryable, message: expect.stringMatching(/the endpoint/u) } });
      expect(JSON.stringify(r)).not.toMatch(new RegExp(`${KEY}|gateway\\.example|proxy`, "u"));
    }
  });

  it("invokeLLM's time limit ends a hanging request: one request, category timeout", async () => {
    const t = fakeFetch((_c, signal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))));
    const inv = await invokeLLM(provider("chat-completions", "prompt-only", t.fetchImpl), structured, { timeoutMs: 50, validate });
    expect(inv.response).toMatchObject({ status: "failed", failure: { category: "timeout" } });
    expect(t.calls).toHaveLength(1);
  });
});

describe("redirects and the key (T27.1)", () => {
  it("a cross-origin redirect is not followed: the other origin receives nothing, the call fails as provider-error", async () => {
    const seen: string[] = [];
    const other = http.createServer((req, res) => { seen.push(String(req.headers.authorization ?? "none")); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(chatAnswer("{\"answer\":\"stolen\"}"))); });
    const first = http.createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as { port: number }).port}/v1/chat/completions` }).end(); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => first.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${(first.address() as { port: number }).port}`;
      const p = createOpenAICompatibleProvider({ baseUrl: `${origin}/v1`, origin, transport: "chat-completions", structuredOutput: "prompt-only", model: "m", apiKey: KEY });
      const r = await p.invoke(structured);
      expect(r).toMatchObject({ status: "failed", failure: { category: "provider-error", message: expect.stringMatching(/redirect \(HTTP 307\); DUO does not follow redirects/u) } });
      expect(seen).toEqual([]);
    } finally {
      first.close();
      other.close();
    }
  });
});

describe("redaction boundary, cache identity and configuration (T27.1)", () => {
  it("repository secrets reach the endpoint only as [REDACTED] (through invokeLLM), in both transports and every mode", async () => {
    for (const transport of ["responses", "chat-completions"] as const) {
      for (const mode of ["json-schema", "json-object", "prompt-only"] as const) {
        const t = fakeFetch(() => json(200, answerFor(transport, JSON.stringify({ answer: "ok" }))));
        const inv = await invokeLLM(provider(transport, mode, t.fetchImpl), { ...structured, instructions: `Judge. key ${OPENAI_SECRET}`, input: `EVIDENCE ev-1 const k = "${AWS_SECRET}";` }, { validate });
        expect(inv.response.status).toBe("success");
        const sent = JSON.stringify(t.calls[0]?.body);
        expect(sent).not.toContain(OPENAI_SECRET);
        expect(sent).not.toContain(AWS_SECRET);
        expect(sent).toContain("[REDACTED]");
      }
    }
  });

  it("the cache identity separates endpoint, transport, model and structured_output; not the key; the endpoint path appears only as a hash", () => {
    const id = (o: Partial<Parameters<typeof createOpenAICompatibleProvider>[0]>) => createOpenAICompatibleProvider({ baseUrl: BASE, origin: "https://gateway.example", transport: "responses", structuredOutput: "json-schema", model: "m-1", apiKey: KEY, ...o }).cacheIdentity?.();
    const base = id({});
    expect(id({ apiKey: "other-key-0123456789" })).toBe(base);
    for (const o of [{ baseUrl: "https://gateway.example/other/v1" }, { transport: "chat-completions" as const }, { model: "m-2" }, { structuredOutput: "prompt-only" as const }]) expect(id(o), JSON.stringify(o)).not.toBe(base);
    expect(base).toContain("origin=https://gateway.example");
    expect(base).not.toContain("/proxy/openai");
    expect(base).not.toContain(KEY);
  });

  it("the response cache hits on the same redacted request (a different secret is the same request) and misses when the endpoint differs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-compat-cache-"));
    try {
      const t = fakeFetch(() => json(200, chatAnswer(JSON.stringify({ answer: "ok" }))));
      const req = (secret: string) => ({ ...structured, input: `EVIDENCE ev-1 token ${secret}` });
      const a = await invokeLLM(provider("chat-completions", "prompt-only", t.fetchImpl), req(OPENAI_SECRET), { validate, cache: { root } });
      const b = await invokeLLM(provider("chat-completions", "prompt-only", t.fetchImpl), req("sk-proj-ANOTHERSECRETVALUE0123456789xyz"), { validate, cache: { root } });
      expect([a.cached, b.cached, t.calls.length]).toEqual([false, true, 1]);
      const c = await invokeLLM(provider("chat-completions", "prompt-only", t.fetchImpl, { baseUrl: "https://gateway.example/other/v1" }), req(OPENAI_SECRET), { validate, cache: { root } });
      expect([c.cached, t.calls.length]).toEqual([false, 2]);
      const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => fs.statSync(path.join(root, f)).isFile());
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const text = fs.readFileSync(path.join(root, f), "utf8");
        for (const s of [OPENAI_SECRET, KEY, "/proxy/openai", "/other/v1"]) expect(text, f).not.toContain(s);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the factory reads the key only from llm.api_key_env, ignores OPENAI_BASE_URL, refuses environment headers and never builds a client for provider none", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "debug"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    expect(createConfiguredLLMProvider(llmConfig(), { OPENAI_API_KEY: KEY })).toMatchObject({ status: "unavailable", reasonCode: "credential-missing", reason: "GMS_API_KEY is not set" });
    const t = fakeFetch(() => json(200, chatAnswer(JSON.stringify({ answer: "ok" }))));
    const ok = createConfiguredLLMProvider(llmConfig(), { GMS_API_KEY: KEY, OPENAI_API_KEY: "sk-official-0123456789abcdef", OPENAI_BASE_URL: "https://elsewhere.example/v1", OPENAI_ORG_ID: "org", OPENAI_LOG: "debug" }, { compatible: { fetch: t.fetchImpl } });
    expect(ok).toMatchObject({ status: "configured", kind: "openai-compatible", model: "m-1", endpoint: { origin: "https://gateway.example", transport: "chat-completions", structuredOutput: "prompt-only" } });
    expect((await ok.provider.invoke(structured)).status).toBe("success");
    expect(t.calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(t.calls[0]?.authorized).toBe(true);
    expect(t.calls[0]?.headers.get("openai-organization")).toBeNull();
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    expect(createConfiguredLLMProvider(llmConfig(), { GMS_API_KEY: KEY, OPENAI_CUSTOM_HEADERS: "x-a: 1" })).toMatchObject({ status: "unavailable", reasonCode: "custom-headers-env" });
    expect(createConfiguredLLMProvider(llmConfig({ baseUrl: "https://api.openai.com/v1" }), { GMS_API_KEY: KEY })).toMatchObject({ status: "unavailable", reasonCode: "config-incomplete" });
    const none = createConfiguredLLMProvider({ ...llmConfig(), provider: "none" }, { GMS_API_KEY: KEY });
    expect(none).toMatchObject({ status: "disabled", kind: "none" });
    expect(none.provider.cacheIdentity?.()).toBeUndefined();
  });
});
