import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, REVIEW_FIXTURE, type ContextRepo } from "../context/testing.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../llm/contract/types.js";
import { reviewChanges, type ReviewOptions } from "./review.js";
import type { ReviewClaim, ReviewRequest, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const W = { from: "HEAD" as const, to: "WORKTREE" as const };

async function review(r: ContextRepo, request: ReviewRequest, extra: Omit<ReviewOptions, "graph" | "registry" | "historyWindow"> = {}): Promise<ReviewResult> {
  const opened = openProjectGraphStore(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(r.root, request, { ...extra, graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  } finally {
    opened.value.close();
  }
}

async function scenario(r: ContextRepo, mutate: () => void, request: ReviewRequest, extra: Omit<ReviewOptions, "graph" | "registry" | "historyWindow"> = {}) {
  r.git("reset", "-q", "--hard");
  r.git("clean", "-fdq");
  mutate();
  await r.index();
  return review(r, request, extra);
}

const rows = (res: ReviewResult) => res.claims.map((c) => `${c.rule} ${c.subject.id} ${c.alignment}${c.blockEligible ? " block" : ""}${c.drift ? " drift" : ""}${c.semanticCandidate ? " semantic" : ""}`);
const claim = (res: ReviewResult, rule: string) => res.claims.find((c) => c.rule === rule) as ReviewClaim;

const aligned = () => repo.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("refresh token expired");');
const SESSION_STORE = "/** Keeps refresh sessions on the server. */\nexport class ServerSessionStore {\n  private readonly sessions = new Map<string, string>();\n\n  save(token: string, userId: string): void {\n    this.sessions.set(token, userId);\n  }\n}\n";

describe("Evidence-backed Review (TASK-013)", () => {
  it("A. aligned change: no conflict, PASS; PASS is not a bug-free certificate", async () => {
    const res = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual(["src/auth/token-service.ts#TokenService.refresh hunk-overlap"]);
    expect(rows(res)).toEqual([
      "constraint-compliance CON-001 UNKNOWN semantic",
      "decision-governance D-004 ALIGNED",
      "requirement-implementation AUTH-03 UNKNOWN semantic",
      "scope-relevance src/auth/token-service.ts ALIGNED",
      "test-coverage AUTH-03 ALIGNED",
    ]);
    // A related file edit is not proof that the Requirement is met: UNKNOWN, never ALIGNED.
    expect(claim(res, "requirement-implementation").reason).toBe("meaning-not-decidable");
    expect(res.verdict).toBe("PASS");
    expect(res.verdictBasis).toEqual({ blocking: [], ask: [], warn: [] });
    expect(res.semanticAssist).toMatchObject({ status: "not-requested", skippedChecks: [
      { rule: "constraint-compliance", reason: "llm-not-requested" }, { rule: "requirement-implementation", reason: "llm-not-requested" },
    ] });
  });

  it("AC-013-02: every claim cites evidence; evidence is deduplicated, ordered, and holds pointers, not code", async () => {
    const res = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    const ids = new Set(res.evidence.map((e) => e.id));
    expect(ids.size).toBe(res.evidence.length);
    expect(res.evidence.map((e) => e.id)).toEqual([...res.evidence.map((e) => e.id)].sort());
    for (const c of res.claims) {
      expect(c.evidenceIds.length).toBeGreaterThan(0);
      for (const id of c.evidenceIds) expect(ids.has(id)).toBe(true);
    }
    const truth = res.evidence.find((e) => e.basis === "project-truth" && e.pointer.id === "AUTH-03");
    expect(truth).toMatchObject({ kind: "requirement", pointer: { kind: "requirement", id: "AUTH-03", path: ".duo-project/specs/auth.md", contentHash: expect.stringMatching(/^sha256:/u) } });
    const hunk = res.evidence.find((e) => e.basis === "git");
    expect(hunk?.pointer).toMatchObject({ kind: "diff", path: "src/auth/token-service.ts", change: "modified" });
    expect(JSON.stringify(res.evidence)).not.toContain("refresh token expired");
  });

  it("deterministic mode: the same state and request give a byte-identical ReviewResult", async () => {
    const one = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    const two = await review(repo, { task: "AUTH-03", diff: W });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("B. an explicit enforced Decision violation: CONFLICT, blockEligible, BLOCK (no LLM)", async () => {
    const res = await scenario(repo, () => repo.write("src/auth/session-store.ts", SESSION_STORE), { task: "AUTH-03", diff: W });
    const c = claim(res, "decision-forbids");
    expect(c).toMatchObject({ subject: { id: "D-004" }, alignment: "CONFLICT", reason: "forbidden-symbol", enforced: true, blockEligible: true, basis: ["project-truth", "repository", "git"] });
    expect(res.verdict).toBe("BLOCK");
    expect(res.verdictBasis.blocking).toEqual([c.id]);
    // Added (untracked) file: current repository evidence plus one all-new hunk.
    expect(res.diff?.files).toEqual([expect.objectContaining({ path: "src/auth/session-store.ts", kind: "untracked", hunks: [expect.objectContaining({ newStart: 1, newLines: 8 })] })]);
    expect(res.metrics.llmCalls).toBe(0);
  });

  it("C. scope drift: an unrelated application file is a WARN drift signal, never a conflict", async () => {
    const res = await scenario(repo, () => repo.edit("src/admin/metrics-export.ts", '.join("\\n")', '.sort().join("\\n")'), { task: "AUTH-03", diff: W });
    expect(rows(res)).toEqual(["scope-relevance src/admin/metrics-export.ts UNKNOWN drift"]);
    expect(res.verdict).toBe("WARN");
    expect(res.claims.some((c) => c.alignment === "CONFLICT")).toBe(false);
  });

  it("D. the change depends on an undecided question: ASK from the Knowledge Gap assessment", async () => {
    const res = await scenario(repo, () => repo.edit("src/presence/presence-service.ts", "members.add(userId);", "members.add(userId.trim());"), { diff: W });
    expect(res.gaps?.requiresHumanInput).toBe(true);
    expect(res.gaps?.gaps.filter((g) => g.action === "ask").map((g) => g.text)).toEqual(["maximum number of users per presence room"]);
    expect(res.verdict).toBe("ASK");
    expect(res.limitations.map((l) => l.code)).toContain("no-task-scope");
  });

  it("E. semantic ambiguity: UNKNOWN without a provider, no failure", async () => {
    const res = await scenario(repo, () => repo.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)"), { task: "RPT-01", diff: W, includeSemanticAssist: true });
    expect(claim(res, "requirement-implementation")).toMatchObject({ subject: { id: "RPT-01" }, alignment: "UNKNOWN", semanticCandidate: true });
    expect(res.verdict).toBe("PASS");
    // AC-013-03: the semantic check is recorded as skipped.
    expect(res.semanticAssist).toMatchObject({ status: "disabled", calls: 0, skippedChecks: [{ rule: "requirement-implementation", reason: "llm-disabled" }] });
  });

  it("F. a confirmed Decision edited in place: decision-integrity CONFLICT, BLOCK", async () => {
    const res = await scenario(repo, () => repo.edit(".duo-project/decisions/D-010.yaml", "answer: usage reports query the read replica", "answer: usage reports query the primary"), { diff: W });
    expect(res.seeds.map((s) => s.ref)).toEqual(["D-010"]);
    expect(claim(res, "decision-integrity")).toMatchObject({ subject: { id: "D-010" }, alignment: "CONFLICT", reason: "confirmed-content-changed", blockEligible: true, basis: ["project-truth", "git"] });
    expect(res.verdict).toBe("BLOCK");
  });

  it("test results from the caller: a failed test blocks only through an enforced Decision", async () => {
    const enforced = await scenario(repo, aligned, {
      task: "AUTH-03", diff: W, testResults: { command: "vitest run", status: "failed", tests: [{ path: "src/auth/token-service.test.ts" as never, name: "TokenService > refresh returns a new access token", status: "failed" }] },
    });
    expect(claim(enforced, "test-result")).toMatchObject({ alignment: "CONFLICT", reason: "related-test-failed", enforced: true, blockEligible: true, basis: ["project-truth", "repository", "test"] });
    expect(enforced.verdict).toBe("BLOCK");
    const warned = await scenario(repo, () => repo.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)"), {
      task: "RPT-01", diff: W, testResults: { status: "failed", tests: [{ path: "src/report/build-report.test.ts" as never, name: "buildReport > sums whole euros", status: "failed" }] },
    });
    expect(claim(warned, "test-result")).toMatchObject({ alignment: "CONFLICT", enforced: false, blockEligible: false });
    expect(warned.verdict).toBe("WARN");
    const passed = await scenario(repo, aligned, { task: "AUTH-03", diff: W, testResults: { status: "passed", tests: [{ path: "src/auth/token-service.test.ts" as never, name: "TokenService > refresh returns a new access token", status: "passed" }] } });
    expect(claim(passed, "test-result")).toMatchObject({ alignment: "ALIGNED", reason: "related-tests-passed" });
    expect(passed.verdict).toBe("PASS");
  });

  it("declared reference: a symbol Project Truth names disappears → PARTIAL, from the Indexer's own diagnostic", async () => {
    const res = await scenario(repo, () => {
      repo.edit("src/auth/token-service.ts", "  refresh(refreshToken: string, now: number): string {", "  renew(refreshToken: string, now: number): string {");
    }, { task: "AUTH-03", diff: W });
    expect(claim(res, "declared-reference")).toMatchObject({ subject: { id: "AUTH-03" }, alignment: "PARTIAL", reason: "declared-symbol-unresolved" });
    expect(claim(res, "declared-reference").observed).toContain("TokenService.refresh");
    expect(res.verdict).toBe("WARN");
  });

  it("deleted and renamed files: Git evidence and limitations, never a failed review", async () => {
    const deleted = await scenario(repo, () => fs.rmSync(path.join(repo.root, "src/admin/metrics-export.ts")), { diff: W });
    expect(deleted.status).toBe("ready");
    expect(deleted.diff?.files).toEqual([expect.objectContaining({ path: "src/admin/metrics-export.ts", kind: "deleted" })]);
    expect(deleted.seeds).toEqual([]);
    expect(deleted.limitations.map((l) => l.code)).toContain("deleted-unresolved");
    const removed = deleted.evidence.filter((e) => e.basis === "git");
    expect(removed.some((e) => e.pointer.change === "removed" && e.metadata?.oldBlob !== undefined)).toBe(true);

    const renamed = await scenario(repo, () => repo.git("mv", "src/admin/metrics-export.ts", "src/admin/export-metrics.ts"), { diff: W });
    const file = renamed.diff?.files[0];
    expect(file).toMatchObject({ path: "src/admin/export-metrics.ts", oldPath: "src/admin/metrics-export.ts", kind: "renamed" });
    const record = renamed.evidence.find((e) => e.metadata?.oldPath === "src/admin/metrics-export.ts");
    expect(record?.metadata).toMatchObject({ change: "renamed", similarity: expect.any(Number) });
    expect(renamed.limitations.map((l) => l.code)).toContain("rename-heuristic");
  });

  it("freshness: a stale index is index-required, and the Review does not index", async () => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    await repo.index();
    aligned();
    const res = await review(repo, { task: "AUTH-03", diff: W });
    expect(res).toMatchObject({ status: "index-required", freshness: { status: "stale" }, claims: [] });
    expect(res.verdict).toBeUndefined();
  });
});

/** A fake provider: answers every CLAIM in the input with the given alignment, citing its first evidence ID (or a bogus one). */
function semanticFake(alignment: string, cite: "first" | "bogus" = "first"): LLMProvider & { calls: number; requests: LLMRequest[] } {
  const p = {
    id: "fake", calls: 0, requests: [] as LLMRequest[], status: () => "configured" as const, cacheIdentity: () => "fake:model-1",
    invoke: (r: LLMRequest): Promise<LLMResponse> => {
      p.calls++;
      p.requests.push(r);
      const claims = [...r.input.matchAll(/^CLAIM (\S+) .*\n.*\n.*\nevidence: (.*)$/gmu)].map((m) => ({
        claim_id: m[1] ?? "", alignment, evidence_ids: cite === "bogus" ? ["ev-0000000000000000"] : [(m[2] ?? "").split(", ")[0] ?? ""], reason: "fake judgement",
      }));
      const value = { claims };
      return Promise.resolve({ status: "success", output: { mode: "structured", text: JSON.stringify(value), value }, usage: { provider: "fake", model: "model-1", inputTokens: 100, outputTokens: 20 } });
    },
  };
  return p;
}

describe("optional semantic assistance (TASK-013)", () => {
  let work: ContextRepo;
  const change = () => work.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
  beforeAll(async () => {
    work = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    work.edit(".duo-project/project.yaml", "current_milestone: M1\n", "current_milestone: M1\nllm:\n  provider: openai-responses\n");
    work.git("commit", "-qam", "enable llm");
    await work.index();
  });

  it("one structured batch; supplemental claims never change the deterministic verdict or block", async () => {
    const provider = semanticFake("CONFLICT");
    const deterministic = await scenario(work, change, { task: "RPT-01", diff: W });
    const res = await review(work, { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: provider });
    expect(provider.calls).toBe(1);
    expect(provider.requests[0]).toMatchObject({ purpose: "review-semantic-check", output: { mode: "structured", name: "review_semantic_check" } });
    expect(res.semanticAssist).toMatchObject({ status: "success", calls: 1, verdict: "WARN" });
    expect(res.semanticAssist.claims).toEqual([expect.objectContaining({ alignment: "CONFLICT", blockEligible: false, basis: expect.arrayContaining(["llm"]) })]);
    // The deterministic part is untouched by the LLM.
    expect(res.verdict).toBe("PASS");
    expect(JSON.stringify(res.claims)).toBe(JSON.stringify(deterministic.claims));
    expect(JSON.stringify(res.evidence)).toBe(JSON.stringify(deterministic.evidence));
    expect(res.metrics.llmCalls).toBe(1);
  });

  it("a cited evidence ID that was not sent: invalid-response, deterministic result kept", async () => {
    const res = await scenario(work, change, { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: semanticFake("CONFLICT", "bogus") });
    expect(res.semanticAssist).toMatchObject({ status: "failed", failure: "invalid-response", claims: [] });
    expect(res.semanticAssist.skippedChecks.map((s) => s.reason)).toEqual(["llm-invalid-response"]);
    expect(res.verdict).toBe("PASS");
  });

  it("LLM cache: a repeated review answers from cache; a changed diff misses", async () => {
    const provider = semanticFake("ALIGNED");
    await scenario(work, change, { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: provider, llmCache: true });
    const again = await review(work, { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: provider, llmCache: true });
    expect(again.semanticAssist).toMatchObject({ status: "success", calls: 0, cacheHits: 1 });
    expect(provider.calls).toBe(1);
    const other = await scenario(work, () => work.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.ceil(cents / 100)"), { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: provider, llmCache: true });
    expect(other.semanticAssist).toMatchObject({ calls: 1, cacheHits: 0 });
    expect(fs.existsSync(path.join(work.root, ".duo-project/cache/llm"))).toBe(true);
    expect(fs.existsSync(path.join(work.root, ".duo-project/cache/packets"))).toBe(false);
  });

  it("an LLM-only CONFLICT never blocks, even on an enforced Decision's code", async () => {
    const res = await scenario(work, () => work.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("refresh token expired");'),
      { task: "AUTH-03", diff: W, includeSemanticAssist: true }, { llm: semanticFake("CONFLICT") });
    expect(res.semanticAssist.claims.length).toBeGreaterThan(0);
    expect(res.semanticAssist.claims.every((c) => c.alignment === "CONFLICT" && !c.blockEligible)).toBe(true);
    expect(res.verdict).toBe("PASS");
    expect(res.semanticAssist.verdict).toBe("WARN");
  });
});
