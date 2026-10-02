/**
 * OpenAIResponsesProvider (TASK-012B, ADR-012): the DUO LLMProvider contract over the official OpenAI
 * Responses API. One stateless request per call: no tools, no conversation, no previous_response_id,
 * store: false. Official endpoint only: the client is pinned to https://api.openai.com/v1 and never
 * takes an endpoint, headers, organization, project or log level from the environment (the factory
 * refuses OPENAI_BASE_URL and OPENAI_CUSTOM_HEADERS; compatible endpoints are the separate
 * openai-compatible provider, T27.1). The SDK is imported on the first call only, so an unused provider costs nothing.
 *
 * Time limits and cancellation come from invokeLLM() (the request signal); the SDK does not retry
 * (maxRetries 0) and its own per-attempt timeout is set above DUO's. Failures are provider-neutral
 * categories with a message built by DUO: SDK error text, headers and the request never leave here.
 * Structured output is parsed here; its schema and evidence citations are validated by invokeLLM()
 * and the caller (the provider-neutral validator stays the final boundary).
 */
import type { LLMFailureCategory, LLMJsonSchema, LLMProvider, LLMRequest, LLMResponse, LLMUsage } from "@duo-director/director";
import { OPENAI_OFFICIAL_BASE_URL } from "@duo-director/core";

export const OPENAI_RESPONSES_PROVIDER_ID = "openai-responses";
/** The only endpoint this provider calls (one source in core, shared with the openai-compatible endpoint policy). */
export { OPENAI_OFFICIAL_BASE_URL };
/** Bump when the request mapping or the handling of answers changes (part of the cache identity). */
export const OPENAI_RESPONSES_ADAPTER_VERSION = "1";
/** Bump when the structured-output conversion (strict json_schema, dropped keywords) changes. */
export const OPENAI_STRUCTURED_OUTPUT_POLICY = "strict-1";
/** SDK per-attempt timeout: above any DUO timeout, so DUO's signal decides (C190). */
const SDK_TIMEOUT_MS = 10 * 60 * 1000;

/** What DUO sends: a subset of the Responses create parameters. */
export interface ResponsesCreateBody {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly store: false;
  readonly max_output_tokens?: number;
  readonly text?: { readonly format: { readonly type: "json_schema"; readonly name: string; readonly schema: LLMJsonSchema; readonly strict: true } };
}

/** The parts of a Response DUO reads. */
export interface ResponsesResult {
  readonly model?: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string } | null;
  readonly output_text?: string;
  readonly output?: readonly { readonly type?: string; readonly content?: readonly { readonly type?: string; readonly text?: string }[] }[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly input_tokens_details?: { readonly cached_tokens?: number } } | null;
}

/** The one call DUO makes; injectable for tests (no network in CI). */
export interface ResponsesClient {
  create(body: ResponsesCreateBody, options: { readonly signal?: AbortSignal }): Promise<ResponsesResult>;
}

/** Options the provider passes to the SDK client (asserted by tests). */
export interface OpenAIClientSettings {
  readonly apiKey: string;
  readonly baseURL: typeof OPENAI_OFFICIAL_BASE_URL;
  readonly maxRetries: 0;
  readonly timeout: number;
  readonly organization: null;
  readonly project: null;
  readonly adminAPIKey: null;
  readonly webhookSecret: null;
  readonly logLevel: "off";
  /** Test-only transport (a fake fetch); never set in production. */
  readonly fetch?: typeof fetch;
}

export interface OpenAIResponsesProviderOptions {
  readonly model: string;
  /** Read by the factory from llm.api_key_env; undefined makes the provider unavailable. */
  readonly apiKey?: string;
  /** Tests: a ready client instead of the SDK. */
  readonly client?: ResponsesClient;
  /** Tests: the SDK with a fake transport (exercises the real SDK request and error handling). */
  readonly fetch?: typeof fetch;
}

export function openAIClientSettings(apiKey: string, fetchImpl?: typeof fetch): OpenAIClientSettings {
  return {
    apiKey, baseURL: OPENAI_OFFICIAL_BASE_URL, maxRetries: 0, timeout: SDK_TIMEOUT_MS,
    organization: null, project: null, adminAPIKey: null, webhookSecret: null, logLevel: "off",
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  };
}

async function sdkClient(settings: OpenAIClientSettings): Promise<ResponsesClient> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI(settings);
  return {
    create: async (body, options) => (await client.responses.create(body, options.signal === undefined ? {} : { signal: options.signal })) as unknown as ResponsesResult,
  };
}

/** Strict json_schema accepts a subset of JSON Schema; drop keywords it rejects (DUO still checks them). */
const UNSUPPORTED_STRICT_KEYWORDS = new Set(["maxLength", "minLength"]);
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !UNSUPPORTED_STRICT_KEYWORDS.has(k)).map(([k, v]) => [k, toStrictSchema(v)]));
}

export function responsesBody(model: string, request: LLMRequest): ResponsesCreateBody {
  return {
    model, instructions: request.instructions, input: request.input, store: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(request.output.mode === "structured"
      ? { text: { format: { type: "json_schema" as const, name: request.output.name, schema: toStrictSchema(request.output.schema) as LLMJsonSchema, strict: true as const } } }
      : {}),
  };
}

function failed(category: LLMFailureCategory, message: string, retryable: boolean, usage?: LLMUsage): LLMResponse {
  return { status: "failed", failure: { category, message, retryable }, ...(usage === undefined ? {} : { usage }) };
}

/**
 * SDK error → category. Only the HTTP status and the error class name are read; the SDK message
 * (which can quote the request or a key fragment) is never copied.
 */
export function failureOf(error: unknown): LLMResponse {
  const e = error as { status?: unknown; name?: unknown; constructor?: { name?: unknown } } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const kind = [e?.constructor?.name, e?.name].find((x): x is string => typeof x === "string") ?? "";
  if (status === 401 || status === 403) return failed("authentication", `OpenAI rejected the credentials (HTTP ${status})`, false);
  if (status === 429) return failed("rate-limit", "OpenAI rate limit or quota reached (HTTP 429)", true);
  if (status === 400 || status === 404 || status === 422) {
    return failed("provider-error", `OpenAI rejected the request (HTTP ${status}: request, model or schema not accepted)`, false);
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return failed("unavailable", `OpenAI is temporarily unavailable (HTTP ${status})`, true);
  if (status !== undefined) return failed("provider-error", `OpenAI returned HTTP ${status}`, false);
  if (/Timeout/u.test(kind)) return failed("timeout", "the OpenAI request timed out", true);
  if (/Abort/u.test(kind)) return failed("cancelled", "the OpenAI request was cancelled", false);
  if (/Connection/u.test(kind)) return failed("unavailable", "could not connect to the OpenAI API", true);
  return failed("provider-error", "the OpenAI request failed", false);
}

function usageOf(model: string, r: ResponsesResult): LLMUsage {
  const u = r.usage ?? undefined;
  return {
    provider: OPENAI_RESPONSES_PROVIDER_ID, model: typeof r.model === "string" && r.model !== "" ? r.model : model,
    ...(typeof u?.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
    ...(typeof u?.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
    ...(typeof u?.input_tokens_details?.cached_tokens === "number" ? { cachedInputTokens: u.input_tokens_details.cached_tokens } : {}),
  };
}

const outputText = (r: ResponsesResult): string => (typeof r.output_text === "string" ? r.output_text
  : (r.output ?? []).flatMap((item) => (item.type === "message" ? item.content ?? [] : [])).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join(""));
const refused = (r: ResponsesResult): boolean => (r.output ?? []).some((item) => (item.content ?? []).some((c) => c.type === "refusal"));

/**
 * A successful HTTP answer that does not carry a usable result is invalid-response: incomplete,
 * refused, empty, or (structured) not JSON. Schema and evidence checks follow in invokeLLM().
 * No model text is quoted in these messages.
 */
export function responseOf(model: string, request: LLMRequest, r: ResponsesResult): LLMResponse {
  const usage = usageOf(model, r);
  if (r.status !== undefined && r.status !== "completed") {
    const reason = r.status === "incomplete" && typeof r.incomplete_details?.reason === "string" ? ` (${r.incomplete_details.reason})` : "";
    return failed("invalid-response", `OpenAI response is ${r.status}${reason}`, false, usage);
  }
  if (refused(r)) return failed("invalid-response", "the model refused to answer", false, usage);
  const text = outputText(r);
  if (text.trim() === "") return failed("invalid-response", "OpenAI response has no output text", false, usage);
  if (request.output.mode === "text") return { status: "success", output: { mode: "text", text }, usage };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failed("invalid-response", "structured output is not valid JSON", false, usage);
  }
  return { status: "success", output: { mode: "structured", text, value }, usage };
}

export function createOpenAIResponsesProvider(options: OpenAIResponsesProviderOptions): LLMProvider {
  const model = options.model.trim();
  const apiKey = options.apiKey;
  const usable = model !== "" && ((apiKey !== undefined && apiKey !== "") || options.client !== undefined);
  let client: Promise<ResponsesClient> | undefined;
  const getClient = () => (client ??= options.client !== undefined ? Promise.resolve(options.client) : sdkClient(openAIClientSettings(apiKey ?? "", options.fetch)));
  return {
    id: OPENAI_RESPONSES_PROVIDER_ID,
    status: () => (usable ? "configured" : "unavailable"),
    cacheIdentity: () => `${OPENAI_RESPONSES_PROVIDER_ID};endpoint=responses;base=official;adapter=${OPENAI_RESPONSES_ADAPTER_VERSION};structured=${OPENAI_STRUCTURED_OUTPUT_POLICY};model=${model}`,
    async invoke(request) {
      if (!usable) return failed("not-configured", "the OpenAI provider has no model or API key", false);
      let result: ResponsesResult;
      try {
        const c = await getClient();
        result = await c.create(responsesBody(model, request), request.signal === undefined ? {} : { signal: request.signal });
      } catch (error) {
        return failureOf(error);
      }
      return responseOf(model, request, result);
    },
  };
}
