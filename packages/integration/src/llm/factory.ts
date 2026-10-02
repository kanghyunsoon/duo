/**
 * LLM provider factory (TASK-012B): project.yaml llm + environment credentials → the one provider
 * every surface uses (CLI per invocation, MCP for its lifetime). Local only: no network, no model
 * catalog, no /models probe. A provider is active only when project.yaml asks for it explicitly
 * (llm.provider: openai-responses and a non-empty llm.model); an API key in the environment alone
 * never turns anything on. The key is read from llm.api_key_env (default OPENAI_API_KEY) and kept
 * only inside the provider: never in project files, metrics, records, cache identities or messages.
 *
 * Official endpoint only (C189): llm.base_url, and OPENAI_BASE_URL / OPENAI_CUSTOM_HEADERS in the
 * environment, make the provider unavailable instead of being honoured or silently ignored, so
 * evidence never goes to an endpoint the user did not expect.
 */
import { createNoopLLMProvider, type LLMProvider, type LLMProviderStatus } from "@duo-director/director";
import { parseCompatibleBaseUrl, type ProjectConfig } from "@duo-director/core";
import { createOpenAICompatibleProvider } from "./compatible/provider.js";
import { createOpenAIResponsesProvider, OPENAI_OFFICIAL_BASE_URL, type OpenAIResponsesProviderOptions } from "./openai/responses.js";

export type LLMEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfiguredLLM {
  readonly provider: LLMProvider;
  readonly status: LLMProviderStatus;
  /** llm.provider as configured. */
  readonly kind: ProjectConfig["llm"]["provider"];
  readonly model?: string;
  /** Why the provider is unavailable (never contains a secret). */
  readonly reason?: string;
  /** The same reason as a stable code (duoctl doctor, T26.1). */
  readonly reasonCode?: LLMUnavailableReason;
  /** openai-compatible (T27.1): the endpoint origin (scheme://host[:port]) and transport, for human output. */
  readonly endpoint?: { readonly origin: string; readonly transport: "responses" | "chat-completions"; readonly structuredOutput: "json-schema" | "json-object" | "prompt-only" };
}

/** Why a configured provider is unavailable. */
export type LLMUnavailableReason = "model-missing" | "base-url-unsupported" | "base-url-env" | "custom-headers-env" | "credential-missing" | "config-incomplete";

export interface LLMFactoryOptions {
  /** Tests: replaces the SDK (fake client or fake fetch). */
  readonly openai?: Pick<OpenAIResponsesProviderOptions, "client" | "fetch">;
  /** Tests: the openai-compatible provider over a fake transport. */
  readonly compatible?: { readonly fetch?: typeof fetch };
}

const official = (url: string) => url.trim().replace(/\/+$/u, "") === OPENAI_OFFICIAL_BASE_URL;

function unavailable(kind: ConfiguredLLM["kind"], model: string | undefined, reasonCode: LLMUnavailableReason, reason: string): ConfiguredLLM {
  const provider: LLMProvider = {
    id: kind,
    status: () => "unavailable",
    invoke: () => Promise.resolve({ status: "failed", failure: { category: "not-configured", message: reason, retryable: false } }),
  };
  return { provider, status: "unavailable", kind, ...(model === undefined ? {} : { model }), reason, reasonCode };
}

export function createConfiguredLLMProvider(config: ProjectConfig["llm"], env: LLMEnvironment, options: LLMFactoryOptions = {}): ConfiguredLLM {
  if (config.provider === "none") return { provider: createNoopLLMProvider(), status: "disabled", kind: "none" };
  if (config.provider === "openai-compatible") return compatible(config, env, options);
  const model = config.model?.trim() ?? "";
  if (model === "") return unavailable(config.provider, undefined, "model-missing", "llm.model is not set (DUO does not pick a model)");
  if (config.baseUrl !== null && !official(config.baseUrl)) {
    return unavailable(config.provider, model, "base-url-unsupported", "llm.base_url is not supported: openai-responses calls the official OpenAI API only");
  }
  const envBase = env.OPENAI_BASE_URL;
  if (envBase !== undefined && envBase.trim() !== "" && !official(envBase)) {
    return unavailable(config.provider, model, "base-url-env", "OPENAI_BASE_URL points elsewhere: openai-responses calls the official OpenAI API only");
  }
  if ((env.OPENAI_CUSTOM_HEADERS ?? "").trim() !== "") {
    return unavailable(config.provider, model, "custom-headers-env", "OPENAI_CUSTOM_HEADERS is set: openai-responses does not send environment-defined headers");
  }
  const key = env[config.apiKeyEnv];
  if ((key === undefined || key.trim() === "") && options.openai?.client === undefined) {
    return unavailable(config.provider, model, "credential-missing", `${config.apiKeyEnv} is not set`);
  }
  const provider = createOpenAIResponsesProvider({ model, ...(key === undefined ? {} : { apiKey: key.trim() }), ...options.openai });
  return { provider, status: provider.status(), kind: config.provider, model };
}

/**
 * openai-compatible (T27.1, H-60): every setting comes from project.yaml (core validated them); the key comes
 * only from the environment variable llm.api_key_env names (no OPENAI_API_KEY fallback). The environment
 * cannot move the endpoint (the SDK gets base_url explicitly, OPENAI_BASE_URL is not read); environment-defined
 * headers make it unavailable like the official provider.
 */
function compatible(config: ProjectConfig["llm"], env: LLMEnvironment, options: LLMFactoryOptions): ConfiguredLLM {
  const model = config.model?.trim() ?? "";
  const endpoint = config.baseUrl === null ? undefined : parseCompatibleBaseUrl(config.baseUrl).value;
  if (model === "" || endpoint === undefined || config.transport === null || config.structuredOutput === null) {
    return unavailable(config.provider, model === "" ? undefined : model, "config-incomplete", "llm settings of openai-compatible are incomplete");
  }
  const shown = { origin: endpoint.origin, transport: config.transport, structuredOutput: config.structuredOutput };
  if ((env.OPENAI_CUSTOM_HEADERS ?? "").trim() !== "") {
    return { ...unavailable(config.provider, model, "custom-headers-env", "OPENAI_CUSTOM_HEADERS is set: openai-compatible does not send environment-defined headers"), endpoint: shown };
  }
  const key = env[config.apiKeyEnv];
  if (key === undefined || key.trim() === "") return { ...unavailable(config.provider, model, "credential-missing", `${config.apiKeyEnv} is not set`), endpoint: shown };
  const provider = createOpenAICompatibleProvider({
    baseUrl: endpoint.baseUrl, origin: endpoint.origin, transport: config.transport, structuredOutput: config.structuredOutput, model, apiKey: key.trim(),
    ...(options.compatible?.fetch === undefined ? {} : { fetch: options.compatible.fetch }),
  });
  return { provider, status: provider.status(), kind: config.provider, model, endpoint: shown };
}

/**
 * Providers by configuration, over one environment snapshot. The MCP server keeps one pool for its
 * lifetime (environment read at startup; restart to pick up a new key) and reuses the provider,
 * which holds no review or conversation state. The CLI makes one per invocation.
 */
export class LLMProviderPool {
  private readonly env: LLMEnvironment;
  private readonly byConfig = new Map<string, ConfiguredLLM>();

  constructor(env: LLMEnvironment, private readonly options: LLMFactoryOptions = {}) {
    this.env = Object.freeze({ ...env });
  }

  forConfig(config: ProjectConfig["llm"]): ConfiguredLLM {
    const key = JSON.stringify([config.provider, config.model, config.apiKeyEnv, config.baseUrl, config.transport, config.structuredOutput]);
    let configured = this.byConfig.get(key);
    if (configured === undefined) {
      configured = createConfiguredLLMProvider(config, this.env, this.options);
      this.byConfig.set(key, configured);
    }
    return configured;
  }
}
