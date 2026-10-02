/**
 * OpenAICompatibleProvider (T27.1, H-49, H-60): the DUO LLMProvider contract over an explicitly
 * configured OpenAI-compatible endpoint. Separate from OpenAIResponsesProvider, which keeps the official
 * endpoint and the Responses API only; the official endpoint is refused here (core endpoint policy).
 *
 * Everything is chosen by the human in project.yaml: base_url, transport (responses or
 * chat-completions), model, api_key_env and structured_output (json-schema, json-object or prompt-only).
 * One request per call with exactly that choice: no fallback to another transport or output mode, no
 * capability probing (/models), no tools, no conversation, no previous_response_id; Responses requests
 * always carry store: false. The SDK does not retry (maxRetries 0), DUO's invokeLLM() owns the time limit,
 * redirects are never followed (a 3xx answer is a failure, so the key never goes to another origin), and
 * the environment cannot change the endpoint, headers, organization, project or log level.
 *
 * Answers are parsed here; invokeLLM() and the caller validate schema and evidence in every mode (a native
 * structured mode is not trusted to have enforced anything). Failures are DUO's categories and messages:
 * no SDK error text, URL path, header or request text leaves here.
 */
import { sha256Text } from "@duo-director/core";
import type { LLMFailureCategory, LLMJsonSchema, LLMProvider, LLMRequest, LLMResponse, LLMUsage } from "@duo-director/director";
import { OPENAI_STRUCTURED_OUTPUT_POLICY, toStrictSchema } from "../openai/responses.js";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";
/** Bump when a request mapping or the handling of answers changes (part of the cache identity). */
export const OPENAI_COMPATIBLE_ADAPTER_VERSION = "1";
const SDK_TIMEOUT_MS = 10 * 60 * 1000;

export type CompatibleTransport = "responses" | "chat-completions";
export type StructuredOutputMode = "json-schema" | "json-object" | "prompt-only";

export interface CompatibleClient {
  responses(body: Record<string, unknown>, options: { readonly signal?: AbortSignal }): Promise<unknown>;
  chat(body: Record<string, unknown>, options: { readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface OpenAICompatibleProviderOptions {
  /** Canonical base URL (core parseCompatibleBaseUrl). */
  readonly baseUrl: string;
  /** scheme://host[:port], for the cache identity and display. */
  readonly origin: string;
  readonly transport: CompatibleTransport;
  readonly structuredOutput: StructuredOutputMode;
  readonly model: string;
  /** Read by the factory from llm.api_key_env; undefined makes the provider unavailable. */
  readonly apiKey?: string;
  /** Tests: the real SDK over a fake transport. */
  readonly fetch?: typeof fetch;
}

/** fetch that never follows a redirect: the 3xx answer comes back as is and becomes a failure. */
export function noRedirectFetch(base: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => base(input, { ...init, redirect: "manual" })) as typeof fetch;
}

export function compatibleClientSettings(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = globalThis.fetch) {
  return {
    apiKey, baseURL: baseUrl, maxRetries: 0, timeout: SDK_TIMEOUT_MS,
    organization: null, project: null, adminAPIKey: null, webhookSecret: null, logLevel: "off" as const,
    fetch: noRedirectFetch(fetchImpl),
  };
}

async function sdkClient(settings: ReturnType<typeof compatibleClientSettings>): Promise<CompatibleClient> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI(settings);
  const opts = (signal?: AbortSignal) => (signal === undefined ? {} : { signal });
  return {
    responses: async (body, o) => client.responses.create(body as never, opts(o.signal)) as unknown,
    chat: async (body, o) => client.chat.completions.create(body as never, opts(o.signal)) as unknown,
  };
}

/** Without a native schema mode, the instructions carry the output requirement; DUO still parses and validates. */
function jsonInstruction(schema: LLMJsonSchema): string {
  return `\n\nAnswer with exactly one JSON object and nothing else (no Markdown, no code fence). It must match this JSON Schema:\n${JSON.stringify(schema)}`;
}

function instructionsFor(request: LLMRequest, mode: StructuredOutputMode): string {
  if (request.output.mode !== "structured" || mode === "json-schema") return request.instructions;
  return request.instructions + jsonInstruction(request.output.schema);
}

/** The Responses request body for one call (exactly one output mode). */
export function compatibleResponsesBody(model: string, mode: StructuredOutputMode, request: LLMRequest): Record<string, unknown> {
  const o = request.output;
  const format = o.mode !== "structured" || mode === "prompt-only" ? undefined
    : mode === "json-schema" ? { type: "json_schema", name: o.name, schema: toStrictSchema(o.schema), strict: true } : { type: "json_object" };
  return {
    model, instructions: instructionsFor(request, mode), input: request.input, store: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(format === undefined ? {} : { text: { format } }),
  };
}

/** The Chat Completions request body for one call: one system and one user message. */
export function compatibleChatBody(model: string, mode: StructuredOutputMode, request: LLMRequest): Record<string, unknown> {
  const o = request.output;
  const format = o.mode !== "structured" || mode === "prompt-only" ? undefined
    : mode === "json-schema" ? { type: "json_schema", json_schema: { name: o.name, schema: toStrictSchema(o.schema), strict: true } } : { type: "json_object" };
  return {
    model, messages: [{ role: "system", content: instructionsFor(request, mode) }, { role: "user", content: request.input }],
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(format === undefined ? {} : { response_format: format }),
  };
}

function failed(category: LLMFailureCategory, message: string, retryable: boolean, usage?: LLMUsage): LLMResponse {
  return { status: "failed", failure: { category, message, retryable }, ...(usage === undefined ? {} : { usage }) };
}

/** SDK error → category. Only the HTTP status and the error class name are read; the SDK message is never copied. */
export function compatibleFailureOf(error: unknown): LLMResponse {
  const e = error as { status?: unknown; name?: unknown; constructor?: { name?: unknown } } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const kind = [e?.constructor?.name, e?.name].find((x): x is string => typeof x === "string") ?? "";
  if (status !== undefined && status >= 300 && status < 400) return failed("provider-error", `the endpoint answered with a redirect (HTTP ${status}); DUO does not follow redirects`, false);
  if (status === 401 || status === 403) return failed("authentication", `the endpoint rejected the credentials (HTTP ${status})`, false);
  if (status === 429) return failed("rate-limit", "the endpoint's rate limit or quota was reached (HTTP 429)", true);
  if (status === 400 || status === 404 || status === 422) {
    return failed("provider-error", `the endpoint rejected the request (HTTP ${status}: model, transport or structured_output not accepted)`, false);
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return failed("unavailable", `the endpoint is temporarily unavailable (HTTP ${status})`, true);
  if (status !== undefined) return failed("provider-error", `the endpoint returned HTTP ${status}`, false);
  if (/Timeout/u.test(kind)) return failed("timeout", "the request to the endpoint timed out", true);
  if (/Abort/u.test(kind)) return failed("cancelled", "the request to the endpoint was cancelled", false);
  if (/Connection/u.test(kind)) return failed("unavailable", "could not connect to the endpoint", true);
  return failed("provider-error", "the request to the endpoint failed", false);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function usageOf(model: string, r: Obj | undefined, transport: CompatibleTransport): LLMUsage {
  const u = obj(r?.usage);
  const input = num(transport === "responses" ? u?.input_tokens : u?.prompt_tokens);
  const output = num(transport === "responses" ? u?.output_tokens : u?.completion_tokens);
  const cached = num(obj(transport === "responses" ? u?.input_tokens_details : u?.prompt_tokens_details)?.cached_tokens);
  return {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID, model: typeof r?.model === "string" && r.model !== "" ? r.model : model,
    ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }), ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/** The answer text of a Responses result, or a reason it has none. */
function responsesText(r: Obj): { text?: string; problem?: string } {
  if (r.status !== undefined && r.status !== "completed") {
    const reason = obj(r.incomplete_details)?.reason;
    return { problem: `the response is ${String(r.status)}${r.status === "incomplete" && typeof reason === "string" ? ` (${reason})` : ""}` };
  }
  const items = Array.isArray(r.output) ? r.output.map(obj) : [];
  const parts = items.flatMap((i) => (i !== undefined && Array.isArray(i.content) ? i.content.map(obj) : []));
  if (parts.some((c) => c?.type === "refusal")) return { problem: "the model refused to answer" };
  const text = typeof r.output_text === "string" ? r.output_text
    : items.filter((i) => i?.type === "message").flatMap((i) => (Array.isArray(i?.content) ? i.content.map(obj) : [])).filter((c) => c?.type === "output_text").map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  return { text };
}

/** The answer text of a Chat Completions result (choices[0].message.content), or a reason it has none. */
function chatText(r: Obj): { text?: string; problem?: string } {
  const choice = Array.isArray(r.choices) ? obj(r.choices[0]) : undefined;
  const message = obj(choice?.message);
  if (choice === undefined || message === undefined) return { problem: "the response has no choices[0].message" };
  if (typeof message.refusal === "string" && message.refusal !== "") return { problem: "the model refused to answer" };
  if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") return { problem: `the response stopped early (${String(choice.finish_reason)})` };
  if (typeof message.content !== "string") return { problem: "choices[0].message.content is not text" };
  return { text: message.content };
}

/** A successful HTTP answer without a usable result is invalid-response. No model text is quoted. */
export function compatibleResponseOf(model: string, transport: CompatibleTransport, request: LLMRequest, raw: unknown): LLMResponse {
  const r = obj(raw);
  const usage = usageOf(model, r, transport);
  if (r === undefined) return failed("invalid-response", "the endpoint's answer is not a JSON object", false, usage);
  const got = transport === "responses" ? responsesText(r) : chatText(r);
  if (got.problem !== undefined) return failed("invalid-response", got.problem, false, usage);
  const text = got.text ?? "";
  if (text.trim() === "") return failed("invalid-response", "the response has no output text", false, usage);
  if (request.output.mode === "text") return { status: "success", output: { mode: "text", text }, usage };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failed("invalid-response", "structured output is not valid JSON", false, usage);
  }
  return { status: "success", output: { mode: "structured", text, value }, usage };
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions, client?: CompatibleClient): LLMProvider {
  const model = options.model.trim();
  const usable = model !== "" && ((options.apiKey !== undefined && options.apiKey !== "") || client !== undefined);
  let pending: Promise<CompatibleClient> | undefined;
  const getClient = () => (pending ??= client !== undefined ? Promise.resolve(client) : sdkClient(compatibleClientSettings(options.baseUrl, options.apiKey ?? "", options.fetch)));
  // The endpoint enters the identity as a hash (its path can be private); the origin is shown anyway.
  const identity = [
    `${OPENAI_COMPATIBLE_PROVIDER_ID}`, `origin=${options.origin}`, `endpoint=${sha256Text(options.baseUrl).slice(0, 16)}`, `transport=${options.transport}`,
    `structured=${options.structuredOutput}`, `policy=${OPENAI_STRUCTURED_OUTPUT_POLICY}`, `adapter=${OPENAI_COMPATIBLE_ADAPTER_VERSION}`, `model=${model}`,
  ].join(";");
  return {
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    status: () => (usable ? "configured" : "unavailable"),
    cacheIdentity: () => identity,
    async invoke(request) {
      if (!usable) return failed("not-configured", "the openai-compatible provider has no model or API key", false);
      let result: unknown;
      try {
        const c = await getClient();
        const signal = request.signal === undefined ? {} : { signal: request.signal };
        result = options.transport === "responses"
          ? await c.responses(compatibleResponsesBody(model, options.structuredOutput, request), signal)
          : await c.chat(compatibleChatBody(model, options.structuredOutput, request), signal);
      } catch (error) {
        return compatibleFailureOf(error);
      }
      return compatibleResponseOf(model, options.transport, request, result);
    },
  };
}

