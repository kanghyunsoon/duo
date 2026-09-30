import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistDeterministic, blockEligible, createNoopLLMProvider, invokeLLM, llmProviderState, llmUsageRecord,
  LLM_CACHE_DIR, type LLMProvider, type LLMRequest, type LLMResponse,
} from "./index.js";

const TEXT: LLMRequest = { purpose: "review-semantic-check", instructions: "Answer briefly.", input: "Packet text", output: { mode: "text" } };
const STRUCTURED: LLMRequest = {
  purpose: "gap-semantic-assist", instructions: "Classify.", input: "Packet",
  output: { mode: "structured", name: "judgement", schema: { type: "object", properties: { alignment: { type: "string" }, evidence_ids: { type: "array" } } } },
};

function fake(answer: LLMResponse | (() => Promise<unknown>), status: "configured" | "disabled" | "unavailable" = "configured"): LLMProvider & { calls: number } {
  const p = {
    id: "fake", calls: 0, status: () => status,
    invoke: () => {
      p.calls++;
      return typeof answer === "function" ? answer() as Promise<LLMResponse> : Promise.resolve(answer);
    },
  };
  return p;
}
const ok = (value?: unknown): LLMResponse => value === undefined
  ? { status: "success", output: { mode: "text", text: "fine" }, usage: { provider: "fake", model: "m-1", inputTokens: 120, outputTokens: 8, cachedInputTokens: 64, latencyMs: 42 } }
  : { status: "success", output: { mode: "structured", text: JSON.stringify(value), value }, usage: { provider: "fake", model: "m-1", inputTokens: 90, outputTokens: 12 } };

afterEach(() => vi.restoreAllMocks());

describe("LLMProvider contract and the no-op provider (TASK-012A)", () => {
  it("AC-012A-01: the no-op provider is disabled, answers not-configured, and does no I/O at all", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const env = process.env;
    const reads: string[] = [];
    process.env = new Proxy(env, { get: (t, k) => { reads.push(String(k)); return Reflect.get(t, k); } });
    try {
      const noop = createNoopLLMProvider();
      expect(noop.status()).toBe("disabled");
      expect(await noop.invoke(TEXT)).toEqual({ status: "failed", failure: { category: "not-configured", message: "LLM is disabled (llm.provider: none)", retryable: false } });
      const inv = await invokeLLM(noop, TEXT);
      expect(inv).toMatchObject({ called: false, provider: "noop", response: { status: "failed", failure: { category: "not-configured" } } });
    } finally {
      process.env = env;
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it("no provider, disabled, unavailable: nothing is called", async () => {
    expect((await invokeLLM(undefined, TEXT)).response).toMatchObject({ status: "failed", failure: { category: "not-configured" } });
    const off = fake(ok(), "disabled");
    expect((await invokeLLM(off, TEXT)).response).toMatchObject({ failure: { category: "not-configured" } });
    const down = fake(ok(), "unavailable");
    expect((await invokeLLM(down, TEXT)).response).toMatchObject({ failure: { category: "unavailable", retryable: true } });
    expect(off.calls + down.calls).toBe(0);
    expect(llmProviderState({ provider: "none" }, fake(ok()))).toBe("disabled");
    expect(llmProviderState({ provider: "openai-responses" })).toBe("unavailable");
    expect(llmProviderState({ provider: "openai-responses" }, fake(ok()))).toBe("configured");
  });

  it("text and structured responses round-trip with provider usage and model", async () => {
    const text = await invokeLLM(fake(ok()), TEXT);
    expect(text.response).toEqual(ok());
    expect(llmUsageRecord(text)).toMatchObject({
      kind: "llm", purpose: "review-semantic-check", provider: "fake", model: "m-1", called: true, status: "success",
      inputTokens: 120, outputTokens: 8, cachedInputTokens: 64, providerLatencyMs: 42, tokenSource: "provider",
      requestEstimate: { estimator: "o200k_base" },
    });
    const value = { alignment: "ALIGNED", evidence_ids: ["req:AUTH-03"] };
    const structured = await invokeLLM(fake(ok(value)), STRUCTURED, { evidence: { allowed: ["req:AUTH-03"], cited: (v) => (v as typeof value).evidence_ids } });
    expect(structured.response).toMatchObject({ status: "success", output: { mode: "structured", value } });
  });

  it("AC-012A-03: usage is only what the provider reported; nothing is estimated into it", async () => {
    const bare = await invokeLLM(fake({ status: "success", output: { mode: "text", text: "x" }, usage: { provider: "fake" } }), TEXT);
    const record = llmUsageRecord(bare);
    expect(record.tokenSource).toBe("none");
    expect(record).not.toHaveProperty("inputTokens");
    expect(record).not.toHaveProperty("outputTokens");
    // DUO's own measurement of what it sent is a separate, labelled field.
    expect(record.requestEstimate.tokens).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("AC-012A-02: a malformed answer, a schema rejection or an uncited evidence ID is an invalid response", async () => {
    expect((await invokeLLM(fake(() => Promise.resolve({ nonsense: true })), TEXT)).response).toMatchObject({ failure: { category: "invalid-response" } });
    expect((await invokeLLM(fake(ok({ a: 1 })), TEXT)).response).toMatchObject({ failure: { category: "invalid-response", message: "expected text output, got structured" } });
    const rejected = await invokeLLM(fake(ok({ alignment: 7 })), STRUCTURED, { validate: (v) => (typeof (v as { alignment?: unknown }).alignment === "string" ? undefined : "alignment must be a string") });
    expect(rejected.response).toMatchObject({ failure: { category: "invalid-response", message: "structured output rejected: alignment must be a string" } });
    const uncited = await invokeLLM(fake(ok({ evidence_ids: ["req:AUTH-03", "req:NOPE-1"] })), STRUCTURED, {
      evidence: { allowed: ["req:AUTH-03"], cited: (v) => (v as { evidence_ids: string[] }).evidence_ids },
    });
    expect(uncited.response).toMatchObject({ failure: { category: "invalid-response", message: "cites evidence that was not provided: req:NOPE-1" } });
  });

  it("a thrown provider error becomes provider-error with secrets redacted", async () => {
    const secret = "sk-" + "proj-abcdefghijklmnopqrstuvwxyz0123";
    const inv = await invokeLLM(fake(() => Promise.reject(new Error(`bad key ${secret}`))), TEXT);
    expect(inv.response).toMatchObject({ status: "failed", failure: { category: "provider-error" } });
    expect(JSON.stringify(inv)).not.toContain(secret);
    expect(JSON.stringify(inv)).toContain("[REDACTED]");
  });

  it("0.1.2 secret boundary: every provider receives instructions and input already redacted, for any purpose; the cache key and estimate use the redacted text", async () => {
    // Test-only dummy values in formats the redactor recognizes.
    const openaiLike = "sk-" + "proj-DUOTEST0000boundary0000dummy";
    const awsLike = "AKIA" + "DUOTEST000000000";
    const received: LLMRequest[] = [];
    const capture: LLMProvider = { id: "capture", status: () => "configured", cacheIdentity: () => "capture:1", invoke: (r) => { received.push(r); return Promise.resolve(ok()); } };
    for (const base of [TEXT, { ...TEXT, purpose: "gap-semantic-assist" as const }]) {
      await invokeLLM(capture, { ...base, instructions: "Rules: " + awsLike, input: "const key = \"" + openaiLike + "\"; keep this" });
    }
    expect(received).toHaveLength(2);
    for (const r of received) {
      expect(JSON.stringify(r)).not.toContain(openaiLike);
      expect(JSON.stringify(r)).not.toContain(awsLike);
      expect(r.input).toBe("const key = \"[REDACTED]\"; keep this");
      expect(r.instructions).toBe("Rules: [REDACTED]");
    }
    // Two requests that differ only in the secret value are the same request once redacted: same cache entry.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-llm-redact-")));
    try {
      const a = await invokeLLM(capture, { ...TEXT, input: "x " + openaiLike }, { cache: { root } });
      const b = await invokeLLM(capture, { ...TEXT, input: "x " + "sk-" + "proj-DUOTEST0000anotherdummy0000" }, { cache: { root } });
      expect(a.called).toBe(true);
      expect(b).toMatchObject({ called: false, cached: true });
      for (const f of fs.readdirSync(path.join(root, LLM_CACHE_DIR))) expect(fs.readFileSync(path.join(root, LLM_CACHE_DIR, f), "utf8")).not.toContain(openaiLike);
      expect(a.requestEstimate.tokens).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  it("AbortSignal: cancelled before the call (no call) and during it", async () => {
    const before = new AbortController();
    before.abort();
    const p = fake(ok());
    expect((await invokeLLM(p, { ...TEXT, signal: before.signal })).response).toMatchObject({ failure: { category: "cancelled" } });
    expect(p.calls).toBe(0);
    const during = new AbortController();
    const slow = fake(() => new Promise((resolve) => { during.abort(); resolve(ok()); }));
    const inv = await invokeLLM(slow, { ...TEXT, signal: during.signal });
    expect(inv).toMatchObject({ called: true, response: { failure: { category: "cancelled" } } });
  });

  it("the deterministic result survives every provider outcome, unchanged", async () => {
    const deterministic = { gaps: [{ id: "gap-1", action: "surface" }], requiresHumanInput: false };
    const snapshot = JSON.stringify(deterministic);
    for (const provider of [undefined, createNoopLLMProvider(), fake(() => Promise.reject(new Error("boom"))), fake(ok())]) {
      const r = await assistDeterministic(deterministic, provider, TEXT);
      expect(r.deterministic).toBe(deterministic);
      expect(JSON.stringify(r.deterministic)).toBe(snapshot);
    }
    expect((await assistDeterministic(deterministic, undefined, undefined)).assistance).toEqual({ status: "not-requested" });
    expect((await assistDeterministic(deterministic, createNoopLLMProvider(), TEXT)).assistance).toEqual({ status: "unavailable", category: "not-configured" });
    expect((await assistDeterministic(deterministic, fake(() => Promise.reject(new Error("boom"))), TEXT)).assistance).toEqual({ status: "failed", category: "provider-error" });
  });

  it("BLOCK needs explicit Project Truth and observable repository evidence; LLM evidence alone never blocks", () => {
    expect(blockEligible(["llm"])).toBe(false);
    expect(blockEligible(["project-truth", "llm"])).toBe(false);
    expect(blockEligible(["repository", "llm"])).toBe(false);
    expect(blockEligible(["project-truth", "repository"])).toBe(true);
    expect(blockEligible(["project-truth", "test", "llm"])).toBe(true);
  });

  it("the public contract has no vendor types and no chat message structure", () => {
    const dir = new URL("./contract/", import.meta.url);
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(new URL(name, dir), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1] ?? "");
      expect(imports.filter((i) => !i.startsWith(".") && !i.startsWith("node:") && !i.startsWith("@duo-director/"))).toEqual([]);
      expect(source).not.toMatch(/\b(?:messages|role)\??\s*:/u);
      expect(source).not.toMatch(/openai|anthropic|chat\.completions/iu);
    }
  });

  it("timeout is enforced by the wrapper even when the provider ignores the signal", async () => {
    const hang = fake(() => new Promise(() => {}));
    const inv = await invokeLLM(hang, TEXT, { timeoutMs: 30 });
    expect(inv).toMatchObject({ called: true, response: { status: "failed", failure: { category: "timeout", retryable: true } } });
    // A provider that honours the combined signal sees it abort.
    let seen: AbortSignal | undefined;
    const polite = fake(() => new Promise(() => {}));
    polite.invoke = (r: LLMRequest) => { seen = r.signal; return new Promise(() => {}); };
    await invokeLLM(polite, TEXT, { timeoutMs: 20 });
    expect(seen?.aborted).toBe(true);
    // The caller's own cancellation is "cancelled", not "timeout".
    const caller = new AbortController();
    const slow = fake(() => new Promise(() => { setTimeout(() => caller.abort(), 5); }));
    expect((await invokeLLM(slow, { ...TEXT, signal: caller.signal }, { timeoutMs: 5000 })).response).toMatchObject({ failure: { category: "cancelled" } });
    expect((await invokeLLM(createNoopLLMProvider(), TEXT, { timeoutMs: 1 })).response).toMatchObject({ failure: { category: "not-configured" } });
  });

  it("response cache: only with a provider identity; hit on the same request, miss on any input or identity change; failures and corrupt entries are not replayed", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-llm-cache-")));
    try {
      const cache = { root };
      const withId = (id: string | undefined, answer: LLMResponse | (() => Promise<unknown>)) => Object.assign(fake(answer), { cacheIdentity: () => id });
      const a = withId("fake:model-1", ok());
      expect((await invokeLLM(a, TEXT, { cache })).cached).toBe(false);
      const hit = await invokeLLM(a, TEXT, { cache });
      expect(hit).toMatchObject({ cached: true, called: false, response: ok() });
      expect(a.calls).toBe(1);
      expect(llmUsageRecord(hit)).toMatchObject({ cached: true, called: false });
      expect((await invokeLLM(a, { ...TEXT, input: "Packet text, changed diff slice" }, { cache })).cached).toBe(false);
      expect((await invokeLLM(a, { ...TEXT, instructions: "Answer briefly. Requirement v2." }, { cache })).cached).toBe(false);
      expect((await invokeLLM(withId("fake:model-2", ok()), TEXT, { cache })).cached).toBe(false);
      const noId = withId(undefined, ok());
      await invokeLLM(noId, TEXT, { cache });
      await invokeLLM(noId, TEXT, { cache });
      expect(noId.calls).toBe(2);
      const failing = withId("fake:failing", () => Promise.reject(new Error("boom")));
      await invokeLLM(failing, TEXT, { cache });
      await invokeLLM(failing, TEXT, { cache });
      expect(failing.calls).toBe(2);
      for (const f of fs.readdirSync(path.join(root, LLM_CACHE_DIR))) fs.writeFileSync(path.join(root, LLM_CACHE_DIR, f), "{ broken");
      const again = withId("fake:model-1", ok());
      expect((await invokeLLM(again, TEXT, { cache })).cached).toBe(false);
      expect(again.calls).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
