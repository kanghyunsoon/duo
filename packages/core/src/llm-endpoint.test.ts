import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "./domain/files.js";
import { isOfficialOpenAIHost, OPENAI_OFFICIAL_BASE_URL, parseCompatibleBaseUrl } from "./llm-endpoint.js";

const project = (llm: string) => parseProjectConfig(".duo-project/project.yaml", `schema_version: 1\nname: p\nllm:\n${llm}`);
const COMPLETE = "  provider: openai-compatible\n  model: m-1\n  base_url: https://gateway.example/v1\n  transport: chat-completions\n  api_key_env: GMS_API_KEY\n  structured_output: prompt-only\n";
const errors = (r: ReturnType<typeof project>) => r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("openai-compatible base_url policy (T27.1, H-60)", () => {
  it("accepts https with any path prefix and strict loopback http; the canonical form keeps the prefix and drops a trailing /", () => {
    const ok: [string, string, string][] = [
      ["https://gateway.example/v1", "https://gateway.example/v1", "https://gateway.example"],
      ["https://gateway.example/prefix/openai/v1/", "https://gateway.example/prefix/openai/v1", "https://gateway.example"],
      ["https://GATEWAY.example:443/v1", "https://gateway.example/v1", "https://gateway.example"],
      ["https://gateway.example", "https://gateway.example", "https://gateway.example"],
      ["http://localhost:8080/v1", "http://localhost:8080/v1", "http://localhost:8080"],
      ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1", "http://127.0.0.1:8080"],
      ["http://127.12.34.56:8080/v1", "http://127.12.34.56:8080/v1", "http://127.12.34.56:8080"],
      ["http://[::1]:8080/v1", "http://[::1]:8080/v1", "http://[::1]:8080"],
    ];
    for (const [raw, baseUrl, origin] of ok) expect(parseCompatibleBaseUrl(raw), raw).toEqual({ value: { baseUrl, origin } });
  });

  it("refuses non-loopback http, other schemes, relative and protocol-relative URLs, userinfo, query, fragment, empty segments and the official OpenAI API", () => {
    const bad: [string, string][] = [
      ["http://gateway.example/v1", "insecure-http"], ["http://192.168.1.10/v1", "insecure-http"], ["http://10.0.0.5/v1", "insecure-http"],
      ["http://my-internal-server/v1", "insecure-http"], ["http://localhost.example/v1", "insecure-http"], ["ftp://gateway.example/v1", "scheme"],
      ["/relative/v1", "not-absolute"], ["//host/v1", "not-absolute"], ["gateway.example/v1", "not-absolute"],
      ["https://user:pass@host.example/v1", "userinfo"], ["https://@host.example/v1", "userinfo"], ["https://host.example/v1?x=1", "query-or-fragment"],
      ["https://host.example/v1?", "query-or-fragment"], ["https://host.example/v1#fragment", "query-or-fragment"], ["https://host.example//v1", "empty-path-segment"],
      [OPENAI_OFFICIAL_BASE_URL, "official-openai"], ["https://API.OPENAI.COM/v1/", "official-openai"], ["https://api.openai.com./v1", "official-openai"],
      ["https://eu.api.openai.com/v1", "official-openai"], ["http://api.openai.com/v1", "insecure-http"],
    ];
    for (const [raw, problem] of bad) expect(parseCompatibleBaseUrl(raw), raw).toEqual({ problem });
    expect(isOfficialOpenAIHost("gateway.example")).toBe(false);
    expect(isOfficialOpenAIHost("notapi.openai.com")).toBe(false);
  });
});

describe("llm configuration (T27.1)", () => {
  it("openai-compatible with every setting is valid and mapped as written", () => {
    const r = project(COMPLETE);
    expect(errors(r)).toEqual([]);
    expect(r.value?.llm).toMatchObject({ provider: "openai-compatible", model: "m-1", baseUrl: "https://gateway.example/v1", transport: "chat-completions", apiKeyEnv: "GMS_API_KEY", structuredOutput: "prompt-only" });
  });

  it("openai-compatible needs model, base_url, transport, api_key_env and structured_output written out: no default, no OPENAI_API_KEY fallback", () => {
    for (const key of ["model", "base_url", "transport", "api_key_env", "structured_output"]) {
      const r = project(COMPLETE.split("\n").filter((l) => !l.trimStart().startsWith(key + ":")).join("\n"));
      expect(r.value, key).toBeUndefined();
      expect(errors(r).join(" "), key).toMatch(new RegExp(`llm\\.${key}: is required for provider openai-compatible`, "u"));
    }
    expect(errors(project(COMPLETE.replace("GMS_API_KEY", "1BAD-NAME")))).toEqual([expect.stringMatching(/api_key_env: must be an environment variable name/u)]);
    expect(project(COMPLETE.replace("prompt-only", "auto")).value).toBeUndefined();
    expect(project(COMPLETE.replace("prompt-only", "none")).value).toBeUndefined();
    expect(project(COMPLETE.replace("chat-completions", "completions")).value).toBeUndefined();
  });

  it("a refused base_url is reported by a code, never by repeating the URL or its user information", () => {
    const r = project(COMPLETE.replace("https://gateway.example/v1", "https://user:hunter2@gateway.example/v1"));
    expect(r.value).toBeUndefined();
    const text = JSON.stringify(r.diagnostics);
    expect(text).toMatch(/must not contain user information/u);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("gateway.example");
    expect(errors(project(COMPLETE.replace("https://gateway.example/v1", "https://api.openai.com/v1")))).toEqual([expect.stringMatching(/official OpenAI API: use provider openai-responses/u)]);
  });

  it("existing configurations keep their meaning; transport and structured_output belong to openai-compatible only", () => {
    expect(project("  provider: none\n").value?.llm).toMatchObject({ provider: "none", apiKeyEnv: "OPENAI_API_KEY", transport: null, structuredOutput: null });
    expect(project("  provider: openai-responses\n  model: gpt-x\n").value?.llm).toMatchObject({ provider: "openai-responses", model: "gpt-x", apiKeyEnv: "OPENAI_API_KEY", baseUrl: null, transport: null });
    expect(project("  provider: openai-responses\n  model: gpt-x\n  base_url: https://proxy.example/v1\n").value?.llm.baseUrl).toBe("https://proxy.example/v1"); // refused at run time, as before
    expect(errors(project("  provider: openai-responses\n  model: gpt-x\n  transport: responses\n"))).toEqual([expect.stringMatching(/llm\.transport: applies only to provider openai-compatible/u)]);
    expect(project("  provider: none\n  transport: responses\n  structured_output: json-object\n").value?.llm.provider).toBe("none");
    expect(parseProjectConfig(".duo-project/project.yaml", "schema_version: 1\nname: p\n").value?.llm).toMatchObject({ provider: "none", transport: null, structuredOutput: null });
  });
});
