/**
 * TASK-012B end-to-end: the shared review operation with the OpenAI Responses provider over a fake
 * transport (the real SDK, no network). Deterministic first: the LLM only adds a separate supplement.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { recordReview, reviewChanges, type ReviewRequest, type ReviewResult } from "@duo-director/director";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLS, type ToolContext } from "../mcp/tools.js";
import { projectReview } from "../operations/review.js";
import { projectStatus } from "../operations/status.js";
import { LLMProviderPool } from "./factory.js";
import { createOpenAIResponsesProvider } from "./openai/responses.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/review/app/", import.meta.url));
const KEY = "sk-test-E2E-SECRET-abcdef0123456789";
const LLM_BLOCK = "llm:\n  provider: openai-responses\n  model: gpt-test-model\n  timeout_ms: 1000\n";
const env = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const temps: string[] = [];
let registry: AnalyzerRegistry;

type Mode = "aligned" | "conflict" | "bogus-evidence" | 401 | 429 | "hang";
let mode: Mode = "aligned";
const calls: { body: Record<string, unknown> }[] = [];

/** The OpenAI API as the SDK sees it: a structured answer for every claim DUO sent, citing what DUO sent. */
const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { input: string; text: { format: { schema: { properties: { claims: { items: { properties: { claim_id: { enum: string[] } } } } } } } } };
  calls.push({ body: body as unknown as Record<string, unknown> });
  if (mode === "hang") return new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  if (typeof mode === "number") return new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: mode, headers: { "content-type": "application/json" } });
  const claimIds = body.text.format.schema.properties.claims.items.properties.claim_id.enum;
  const evidence = [...body.input.matchAll(/^EVIDENCE (\S+)/gmu)].map((m) => m[1] as string);
  const answer = { claims: claimIds.map((id) => ({ claim_id: id, alignment: mode === "conflict" ? "CONFLICT" : "ALIGNED", evidence_ids: mode === "bogus-evidence" ? ["ev-999"] : evidence.slice(0, 1), reason: "rounding differs from the Requirement" })) };
  return new Response(JSON.stringify({
    id: "resp_e2e", object: "response", created_at: 1, status: "completed", model: "gpt-test-model-2026",
    output: [{ type: "message", id: "m", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }] }],
    usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 980 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function repoWith(projectYamlExtra: string): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-t12b-")));
  temps.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.appendFileSync(path.join(root, ".duo-project", "project.yaml"), projectYamlExtra);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env, windowsHide: true, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-qm", "init");
  const file = path.join(root, "src/report/build-report.ts");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Math.floor(cents / 100)", "Math.round(cents / 100)"));
  // Review never indexes: the index is brought current after the change (HEAD → WORKTREE stays the diff).
  const store = openProjectGraphStore(root).value;
  if (store === undefined) throw new Error("graph");
  try { await indexRepository(root, { store, registry }); } finally { store.close(); }
  return root;
}

const pool = (withKey = true) => new LLMProviderPool(withKey ? { OPENAI_API_KEY: KEY } : {}, { openai: { fetch: fakeFetch } });
const REQUEST: ReviewRequest = { task: "RPT-01", diff: { from: "HEAD", to: "WORKTREE" } };
async function review(root: string, request: ReviewRequest, p: LLMProviderPool): Promise<ReviewResult> {
  const op = await projectReview(root, request, { registry, llm: p });
  if (op.kind !== "ok") throw new Error(JSON.stringify(op));
  return op.payload;
}
const deterministic = (r: ReviewResult) => JSON.stringify({ verdict: r.verdict, verdictBasis: r.verdictBasis, claims: r.claims, evidence: r.evidence, gaps: r.gaps, limitations: r.limitations });

let root: string;
let globalFetch: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error("registry");
  registry = created.value;
  // Nothing may reach the real network: the provider only gets the injected transport.
  globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off in tests"));
  root = await repoWith(LLM_BLOCK);
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  globalFetch.mockRestore();
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("TASK-012B semantic review with OpenAI Responses (fake transport)", () => {
  it("provider disabled (llm.provider none): deterministic result, llmCalls 0, no request", async () => {
    const off = await repoWith("");
    const before = calls.length;
    const r = await review(off, { ...REQUEST, includeSemanticAssist: true }, pool());
    expect(r.semanticAssist).toMatchObject({ status: "disabled", calls: 0 });
    expect(r.metrics.llmCalls).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("provider configured but no semantic flag: no request, llmCalls 0", async () => {
    const before = calls.length;
    const r = await review(root, REQUEST, pool());
    expect(r.semanticAssist.status).toBe("not-requested");
    expect(r.metrics.llmCalls).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("configured, key missing: status unavailable (no network), semantic request skipped", async () => {
    const status = await projectStatus(root, { registry, llm: pool(false) });
    expect(status.kind === "ok" ? status.payload : {}).toMatchObject({ llm: "unavailable", llmProvider: { provider: "openai-responses", model: "gpt-test-model", status: "unavailable", reason: "OPENAI_API_KEY is not set" } });
    const configured = await projectStatus(root, { registry, llm: pool() });
    expect(configured.kind === "ok" ? configured.payload : {}).toMatchObject({ llm: "configured", llmProvider: { status: "configured" } });
    expect(JSON.stringify(configured)).not.toContain(KEY);
    const before = calls.length;
    const r = await review(root, { ...REQUEST, includeSemanticAssist: true }, pool(false));
    expect(r.semanticAssist).toMatchObject({ status: "unavailable", calls: 0 });
    expect(calls.length).toBe(before);
  });

  it("semantic success: deterministic Review unchanged, supplement attached, one request with only candidate evidence", async () => {
    mode = "aligned";
    const plain = await review(root, REQUEST, pool());
    const before = calls.length;
    const r = await review(root, { ...REQUEST, includeSemanticAssist: true }, new LLMProviderPool({ OPENAI_API_KEY: KEY }, { openai: { fetch: fakeFetch } }));
    expect(deterministic(r)).toBe(deterministic(plain));
    expect(r.semanticAssist).toMatchObject({ status: "success", provider: { id: "openai-responses", model: "gpt-test-model-2026" }, usage: { inputTokens: 900, outputTokens: 80, cachedInputTokens: 0 } });
    expect(r.metrics.llmCalls + r.metrics.llmCacheHits).toBe(1);
    expect(calls.length - before).toBeLessThanOrEqual(1);
    const sent = calls.at(-1)?.body as { input: string; store: boolean; tools?: unknown };
    expect(sent.store).toBe(false);
    expect(sent.tools).toBeUndefined();
    expect(sent.input).toMatch(/^CLAIM claim-/mu);
    expect(sent.input).not.toContain("presence-service"); // no unrelated repository file
  });

  it("semantic CONFLICT only: deterministic PASS stays, never BLOCK, at most WARN, claims kept apart", async () => {
    mode = "conflict";
    fs.rmSync(path.join(root, ".duo-project", "cache", "llm"), { recursive: true, force: true });
    const r = await review(root, { ...REQUEST, includeSemanticAssist: true }, pool());
    expect(r.verdict).toBe("PASS");
    expect(r.semanticAssist.verdict).toBe("WARN");
    expect(r.semanticAssist.claims.length).toBeGreaterThan(0);
    expect(r.semanticAssist.claims.every((c) => c.alignment === "CONFLICT" && !c.blockEligible)).toBe(true);
    expect(r.claims.every((c) => c.alignment !== "CONFLICT")).toBe(true);
  });

  it.each([
    ["bogus-evidence", "invalid-response"], [401, "authentication"], [429, "rate-limit"], ["hang", "timeout"],
  ] as const)("%s → semantic failure %s, deterministic Review preserved, no secret", async (m, failure) => {
    mode = m;
    fs.rmSync(path.join(root, ".duo-project", "cache", "llm"), { recursive: true, force: true });
    const plain = await review(root, REQUEST, pool());
    const r = await review(root, { ...REQUEST, includeSemanticAssist: true }, pool());
    expect(r.semanticAssist).toMatchObject({ status: "failed", failure, claims: [] });
    expect(deterministic(r)).toBe(deterministic(plain));
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("cache: the same request is one API call then a hit; another model misses", async () => {
    mode = "aligned";
    fs.rmSync(path.join(root, ".duo-project", "cache", "llm"), { recursive: true, force: true });
    const before = calls.length;
    const first = await review(root, { ...REQUEST, includeSemanticAssist: true }, pool());
    const again = await review(root, { ...REQUEST, includeSemanticAssist: true }, pool());
    expect([first.semanticAssist.calls, again.semanticAssist.calls, again.semanticAssist.cacheHits]).toEqual([1, 0, 1]);
    expect(calls.length - before).toBe(1);
    expect(again.semanticAssist.claims).toEqual(first.semanticAssist.claims);
    expect(again.semanticAssist.usage).toBeUndefined(); // no tokens spent on a hit
    const graph = openProjectGraphReader(root).value;
    if (graph === undefined) throw new Error("graph");
    try {
      const other = createOpenAIResponsesProvider({ model: "gpt-other-model", apiKey: KEY, fetch: fakeFetch });
      const r = await reviewChanges(root, { ...REQUEST, includeSemanticAssist: true }, { graph, registry, llm: other, llmCache: true });
      expect(r.value?.result.semanticAssist).toMatchObject({ calls: 1, cacheHits: 0 });
    } finally {
      graph.close();
    }
    const cached = fs.readdirSync(path.join(root, ".duo-project", "cache", "llm")).map((f) => fs.readFileSync(path.join(root, ".duo-project", "cache", "llm", f), "utf8")).join("\n");
    expect(cached).not.toContain(KEY);
    expect(cached).not.toContain("Math.round"); // validated answers only: no prompt or source text
  });

  it("Review Record: the same deterministic review ID with and without semantic assistance; the supplement is a separate file", async () => {
    mode = "aligned";
    const actor = { kind: "human" as const, name: "Ada" };
    const clock = () => new Date("2026-09-28T00:00:00Z");
    const plain = await recordReview(await review(root, REQUEST, pool()), { root, actor, clock });
    const assisted = await recordReview(await review(root, { ...REQUEST, includeSemanticAssist: true }, pool()), { root, actor, clock });
    expect(assisted.value?.id).toBe(plain.value?.id);
    expect(assisted.value?.status).toBe("unchanged");
    expect(plain.value?.assist).toBeUndefined();
    expect(assisted.value?.assist?.path).toBe(`.duo-project/reviews/${plain.value?.id ?? ""}.${assisted.value?.assist?.id ?? ""}.json`);
    expect(assisted.value?.assist?.id).toMatch(/^assist-[0-9a-f]{16}$/u);
    const text = fs.readFileSync(path.join(root, assisted.value?.assist?.path ?? ""), "utf8");
    expect(text).not.toContain("rounding differs"); // no model wording in history
    expect(text).not.toContain(KEY);
  });

  it("MCP duo_review_changes uses the same shared operation: identical semantic payload", async () => {
    mode = "aligned";
    const p = pool();
    const cli = await review(root, { ...REQUEST, includeSemanticAssist: true }, p);
    const ctx: ToolContext = { root, agentName: "agent-test", signal: new AbortController().signal, llm: p };
    const mcp = await TOOLS.duo_review_changes.run({ task: "RPT-01", includeSemanticAssist: true }, ctx);
    const payload = mcp.op.kind === "ok" ? (mcp.op.payload as ReviewResult) : undefined;
    const shape = (r: ReviewResult | undefined) => ({ ...r?.semanticAssist, calls: undefined, cacheHits: undefined, usage: undefined });
    expect(shape(payload)).toEqual(shape(cli));
    expect(deterministic(payload as ReviewResult)).toBe(deterministic(cli));
    expect(mcp.metric).toMatchObject({ llmProvider: "openai-responses", semanticStatus: "success" });
    expect(JSON.stringify(mcp.metric)).not.toContain("RPT-01");
  });

  it("no hidden semantic call: status, context, trace, impact, search, requirement, decision, propose and a plain review never call the provider", async () => {
    const p = pool();
    const ctx: ToolContext = { root, agentName: "agent-test", signal: new AbortController().signal, llm: p };
    const before = calls.length;
    await TOOLS.duo_get_status.run({}, ctx);
    await TOOLS.duo_get_context.run({ task: "RPT-01" }, ctx);
    await TOOLS.duo_trace.run({ node: "RPT-01" }, ctx);
    await TOOLS.duo_impact.run({ node: "RPT-01" }, ctx);
    await TOOLS.duo_search_evidence.run({ query: "report" }, ctx);
    await TOOLS.duo_get_requirement.run({ id: "RPT-01" }, ctx);
    await TOOLS.duo_get_decision.run({ id: "D-010" }, ctx);
    await TOOLS.duo_review_changes.run({ task: "RPT-01" }, ctx);
    await TOOLS.duo_propose_decision.run({ title: "Round reports", question: "report_rounding", answer: "round half up" }, ctx);
    expect(calls.length).toBe(before);
  });
});
