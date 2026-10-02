/**
 * Opt-in real call (T12B): one tiny text request and one strict structured request through the
 * configured OpenAIResponsesProvider. It sends no repository content. Skipped unless
 * DUO_OPENAI_SMOKE=1, OPENAI_API_KEY and DUO_OPENAI_SMOKE_MODEL (an explicit model ID) are set.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry } from "@duo-director/analyzer";
import { reviewChanges } from "@duo-director/director";
import { indexRepository, openProjectGraphStore } from "@duo-director/graph";
import { createConfiguredLLMProvider } from "@duo-director/integration";
import { afterAll, describe, expect, it } from "vitest";

const model = process.env.DUO_OPENAI_SMOKE_MODEL ?? "";
const enabled = process.env.DUO_OPENAI_SMOKE === "1" && (process.env.OPENAI_API_KEY ?? "") !== "" && model !== "";
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Real network calls, observed: only the request metadata is kept (endpoint path, method, store, output
 * format), never instructions, input or response text. Release Hardening (§29) records the outcome in
 * .dist/openai-smoke.json for release:preflight: commit, model and which checks passed; no prompt or source.
 */
const requests: { path: string; method: string; store: unknown; format?: string; strict?: unknown }[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { store?: unknown; text?: { format?: { type?: string; strict?: unknown } } } : {};
  requests.push({ path: `${url.origin}${url.pathname}`, method: init?.method ?? "GET", store: body.store, ...(body.text?.format === undefined ? {} : { format: body.text.format.type, strict: body.text.format.strict }) });
  return fetch(input, init);
};
const checks: Record<string, boolean> = {};
afterAll(() => {
  if (!enabled) return;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  fs.mkdirSync(path.join(REPO, ".dist"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".dist", "openai-smoke.json"), `${JSON.stringify({ format: "duo.openai-smoke/1", commit, model, checks, passed: Object.values(checks).length >= 7 && Object.values(checks).every(Boolean) }, null, 2)}\n`);
});

describe.skipIf(!enabled)("OpenAI Responses smoke (opt-in)", () => {
  const llm = { provider: "openai-responses" as const, model, apiKeyEnv: "OPENAI_API_KEY", baseUrl: null, transport: null, structuredOutput: null, maxCallsPerReview: 1, maxInputTokens: 4000, timeoutMs: 60_000, cache: false };

  it("text and strict structured output, provider-reported usage", async () => {
    const { provider, status } = createConfiguredLLMProvider(llm, process.env, { openai: { fetch: recordingFetch } });
    expect(status).toBe("configured");
    const signal = AbortSignal.timeout(60_000);
    const text = await provider.invoke({ purpose: "review-semantic-check", instructions: "Answer with the single word: ready", input: "ping", output: { mode: "text" }, maxOutputTokens: 200, signal });
    expect(text.status, JSON.stringify(text)).toBe("success");
    const schema = { type: "object", additionalProperties: false, required: ["answer", "evidence_ids"], properties: { answer: { type: "string", enum: ["ALIGNED", "UNKNOWN"] }, evidence_ids: { type: "array", items: { type: "string" } } } };
    const structured = await provider.invoke({
      purpose: "review-semantic-check", instructions: "Answer ALIGNED and cite evidence ev-1 only.", input: "EVIDENCE ev-1: the code matches.",
      output: { mode: "structured", name: "smoke", schema }, maxOutputTokens: 400, signal,
    });
    expect(structured.status, JSON.stringify(structured)).toBe("success");
    if (structured.status !== "success" || structured.output.mode !== "structured") return;
    const value = structured.output.value as { answer: string; evidence_ids: string[] };
    expect(["ALIGNED", "UNKNOWN"]).toContain(value.answer);
    expect(value.evidence_ids.every((id) => id === "ev-1")).toBe(true);
    expect(structured.usage.provider).toBe("openai-responses");
    expect(typeof structured.usage.inputTokens).toBe("number");
    checks.requestSuccess = text.status === "success";
    checks.responsesApi = requests.length >= 2 && requests.every((r) => r.path === "https://api.openai.com/v1/responses" && r.method === "POST");
    checks.storeFalse = requests.length >= 2 && requests.every((r) => r.store === false);
    checks.strictStructuredOutput = requests.some((r) => r.format === "json_schema" && r.strict === true);
    checks.usageMapping = typeof structured.usage.inputTokens === "number" && typeof structured.usage.outputTokens === "number";
    expect(checks).toMatchObject({ responsesApi: true, storeFalse: true, strictStructuredOutput: true });
  });

  it("a Review with real semantic assistance: DUO validates the answer and the deterministic Review is unchanged", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-openai-smoke-")));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env: gitEnv, windowsHide: true, stdio: "pipe" });
    const registry = (await createDefaultAnalyzerRegistry()).value;
    if (registry === undefined) throw new Error("registry");
    try {
      fs.cpSync(path.join(REPO, "fixtures", "review", "app"), root, { recursive: true });
      fs.appendFileSync(path.join(root, ".duo-project", "project.yaml"), `llm:\n  provider: openai-responses\n  model: ${model}\n  cache: false\n`);
      git("-c", "init.defaultBranch=main", "init", "-q");
      git("config", "core.autocrlf", "false");
      git("add", "-A");
      git("commit", "-qm", "smoke");
      const file = path.join(root, "src", "report", "build-report.ts");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Math.floor(cents / 100)", "Math.round(cents / 100)"));
      const store = openProjectGraphStore(root).value;
      if (store === undefined) throw new Error("graph");
      try {
        if ((await indexRepository(root, { store, registry })).value === undefined) throw new Error("index");
        const request = { task: "RPT-01", diff: { from: "HEAD" as const, to: "WORKTREE" as const } };
        const plain = await reviewChanges(root, request, { graph: store, registry });
        const { provider } = createConfiguredLLMProvider(llm, process.env, { openai: { fetch: recordingFetch } });
        const assisted = await reviewChanges(root, { ...request, includeSemanticAssist: true }, { graph: store, registry, llm: provider });
        const a = plain.value?.result;
        const b = assisted.value?.result;
        if (a === undefined || b === undefined) throw new Error("review");
        const assist = b.semanticAssist;
        const claimIds = new Set(b.claims.map((c) => c.id));
        const evidenceIds = new Set([...b.evidence.map((e) => e.id), ...assist.evidence.map((e) => e.id)]);
        checks.semanticSuccess = assist.status === "success" && assist.calls === 1;
        checks.duoFinalValidation = assist.claims.every((c) => claimIds.has(c.claimId) && c.blockEligible === false && c.evidenceIds.every((id) => evidenceIds.has(id)))
          && (assist.verdict === undefined || assist.verdict !== "BLOCK");
        checks.deterministicReviewUnchanged = JSON.stringify(b.claims) === JSON.stringify(a.claims) && b.verdict === a.verdict && JSON.stringify(b.evidence) === JSON.stringify(a.evidence);
        expect(checks).toMatchObject({ semanticSuccess: true, duoFinalValidation: true, deterministicReviewUnchanged: true });
      } finally { store.close(); }
    } finally {
      registry.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
