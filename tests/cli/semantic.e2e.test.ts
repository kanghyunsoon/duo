/**
 * T12B through the built CLI (subprocess): --semantic reaches the shared review operation, plain review
 * never asks for semantic assistance, and status reports the provider state from configuration and
 * environment only (no network: these runs have no usable key or no provider).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const envWithout = (...names: string[]) => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const n of names) delete e[n];
  return e;
};

describe("duoctl review --semantic and LLM status (T12B)", () => {
  const p = existingProject(temps);

  it("provider none (the default): an API key in the environment turns nothing on", () => {
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const s = duoctl(p.root, ["status", "--json"], "", { ...process.env, OPENAI_API_KEY: "sk-test-not-used" }).json().result;
    expect(s).toMatchObject({ llm: "disabled", llmProvider: { provider: "none", status: "disabled" } });
    p.edit("src/scheduler.ts", "% 7", "% 6");
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    const plain = duoctl(p.root, ["review", "--json"]).json().result;
    expect(plain.semanticAssist.status).toBe("not-requested");
    const semantic = duoctl(p.root, ["review", "--semantic", "--json"]).json().result;
    expect(semantic.semanticAssist.status).not.toBe("not-requested"); // the flag reached the operation
    expect(semantic.metrics.llmCalls).toBe(0);
    expect(JSON.stringify({ ...semantic, semanticAssist: undefined })).toBe(JSON.stringify({ ...plain, semanticAssist: undefined }));
  });

  it("openai-responses configured: unavailable without the key, configured with it, refused with a custom endpoint; status makes no request", () => {
    fs.appendFileSync(path.join(p.root, ".duo-project", "project.yaml"), "llm:\n  provider: openai-responses\n  model: gpt-test-model\n");
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    const missing = duoctl(p.root, ["status", "--json"], "", envWithout("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_CUSTOM_HEADERS")).json().result;
    expect(missing).toMatchObject({ llm: "unavailable", llmProvider: { provider: "openai-responses", model: "gpt-test-model", status: "unavailable", reason: "OPENAI_API_KEY is not set" } });
    const human = duoctl(p.root, ["status"], "", envWithout("OPENAI_API_KEY"));
    expect(human.stdout).toMatch(/LLM: unavailable · openai-responses gpt-test-model · OPENAI_API_KEY is not set/u);
    const withKey = duoctl(p.root, ["status", "--json"], "", { ...envWithout("OPENAI_BASE_URL", "OPENAI_CUSTOM_HEADERS"), OPENAI_API_KEY: "sk-test-status-only" });
    expect(withKey.json().result.llmProvider).toMatchObject({ status: "configured" });
    expect(withKey.stdout).not.toContain("sk-test-status-only");
    const proxy = duoctl(p.root, ["status", "--json"], "", { ...process.env, OPENAI_API_KEY: "sk-test-status-only", OPENAI_BASE_URL: "https://proxy.example.invalid/v1" }).json().result;
    expect(proxy.llmProvider).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/OPENAI_BASE_URL/u) });
    const review = duoctl(p.root, ["review", "--semantic", "--json"], "", envWithout("OPENAI_API_KEY")).json().result;
    expect(review.metrics.llmCalls).toBe(0);
    const metrics = fs.readFileSync(path.join(p.root, ".duo-project", "runtime", "metrics.jsonl"), "utf8");
    expect(metrics).not.toContain("sk-test");
  });
});
