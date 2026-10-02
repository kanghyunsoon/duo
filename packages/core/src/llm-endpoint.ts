/**
 * LLM endpoint policy (T27.1, H-60). One source for the official OpenAI API address (the official
 * provider calls only it) and for the base_url rule of the openai-compatible provider: an absolute URL,
 * https, or http on a strict loopback host (localhost, 127.0.0.0/8, [::1]); no user information, query,
 * fragment or empty path segment; never the official OpenAI API (that is the official provider's job,
 * Responses API only). Parsing is the WHATWG URL parser; the canonical form (origin + path without a
 * trailing /) is what requests are built from, what the cache identity hashes and what is shown (origin).
 * Problems are codes: the raw value, which can carry credentials, is never echoed.
 */

export const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com/v1";

const OFFICIAL_HOST = new URL(OPENAI_OFFICIAL_BASE_URL).hostname;

export type CompatibleBaseUrlProblem = "not-absolute" | "scheme" | "insecure-http" | "userinfo" | "query-or-fragment" | "empty-path-segment" | "official-openai";

export interface CompatibleEndpoint {
  /** origin + path, no trailing "/": the SDK base URL; request paths (/responses, /chat/completions) are appended. */
  readonly baseUrl: string;
  /** scheme://host[:port]: the only part DUO shows. */
  readonly origin: string;
}

/** The official OpenAI API host, or one of its subdomains (data residency hosts). */
export function isOfficialOpenAIHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/u, "");
  return h === OFFICIAL_HOST || h.endsWith(`.${OFFICIAL_HOST}`);
}

/** localhost, 127.0.0.0/8 or [::1], as the URL parser normalizes them. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);
}

export function parseCompatibleBaseUrl(raw: string): { readonly value?: CompatibleEndpoint; readonly problem?: CompatibleBaseUrlProblem } {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw)) return { problem: "not-absolute" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "not-absolute" };
  }
  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/u)[0] ?? "";
  if (url.username !== "" || url.password !== "" || authority.includes("@")) return { problem: "userinfo" };
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) return { problem: "query-or-fragment" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "scheme" };
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return { problem: "insecure-http" };
  if (isOfficialOpenAIHost(url.hostname)) return { problem: "official-openai" };
  const path = url.pathname.replace(/\/+$/u, "");
  if (path.includes("//")) return { problem: "empty-path-segment" };
  return { value: { baseUrl: `${url.origin}${path}`, origin: url.origin } };
}

export const COMPATIBLE_BASE_URL_PROBLEMS: Readonly<Record<CompatibleBaseUrlProblem, string>> = {
  "not-absolute": "must be an absolute URL (https://host/path)",
  scheme: "must use https (or http on a loopback host)",
  "insecure-http": "http is allowed only on a loopback host (localhost, 127.0.0.0/8, [::1]); use https",
  userinfo: "must not contain user information (user:password@); put the key in the environment variable named by llm.api_key_env",
  "query-or-fragment": "must not contain a query (?) or a fragment (#)",
  "empty-path-segment": "must not contain an empty path segment (//)",
  "official-openai": "is the official OpenAI API: use provider openai-responses (official endpoint, Responses API)",
};

/** A valid environment variable name for llm.api_key_env of openai-compatible. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
