import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { externalSourceSlice } from "@duo-director/core";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, REVIEW_FIXTURE, type ContextRepo } from "../context/testing.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../llm/contract/types.js";
import { listReviewRecords, recordReview, verifyReviewRecord } from "./record.js";
import { reviewChanges, type ReviewOptions } from "./review.js";
import { nonApplicationReason } from "./scope.js";
import type { ReviewRequest, ReviewResult } from "./types.js";

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
const human = { kind: "human" as const, name: "Ada" };
const clock = () => new Date("2026-09-28T00:00:00.000Z");

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

/** Every file under root except .git, with its bytes. */
function snapshot(root: string): [string, string][] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => !f.split(path.sep).includes(".git") && fs.statSync(path.join(root, f)).isFile())
    .sort().map((f) => [f, fs.readFileSync(path.join(root, f)).toString("base64")]);
}

const reviewsDir = (r: ContextRepo) => path.join(r.root, ".duo-project", "reviews");
const recordFiles = (r: ContextRepo) => (fs.existsSync(reviewsDir(r)) ? fs.readdirSync(reviewsDir(r)).sort() : []);
const rows = (res: ReviewResult) => res.claims.map((c) => [c.rule, c.subject.id, c.alignment, c.blockEligible ? "block" : "", c.drift ? "drift" : "", c.semanticCandidate ? "semantic" : ""].filter((x) => x !== "").join(" "));
const aligned = () => repo.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("refresh token expired");');
const metricsSort = (r: ContextRepo) => r.edit("src/admin/metrics-export.ts", '.join("\\n")', '.sort().join("\\n")');

describe("Review history read boundary (T18.1)", () => {
  it("rejects a symlinked reviews directory before reading its target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-review-link-"));
    try {
      const project = path.join(root, ".duo-project");
      const outside = path.join(root, "outside");
      fs.mkdirSync(project);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "review-0123456789abcdef.json"), "private data");
      fs.symlinkSync(outside, path.join(project, "reviews"), process.platform === "win32" ? "junction" : "dir");
      const result = await listReviewRecords(root);
      expect(result.value).toBeUndefined();
      expect(result.diagnostics.map((d) => d.code)).toContain("REVIEW_RECORD_INTEGRITY");
    } finally {
      if (path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("Review Record (T13.1, AC-013-05)", () => {
  it("a Review writes nothing; only an explicit recordReview() writes under reviews/", async () => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    aligned();
    await repo.index();
    const before = snapshot(repo.root);
    const res = await review(repo, { task: "AUTH-03", diff: W });
    expect(snapshot(repo.root)).toEqual(before);
    expect(recordFiles(repo)).toEqual([]);

    const rec = await recordReview(res, { root: repo.root, actor: human, clock });
    expect(rec.value).toMatchObject({ status: "created", path: expect.stringMatching(/^\.duo-project\/reviews\/review-[0-9a-f]{16}\.json$/u) });
    expect(recordFiles(repo)).toEqual([(rec.value?.id ?? "") + ".json"]);
    const text = fs.readFileSync(path.join(repo.root, rec.value?.path ?? ""), "utf8");
    const file = JSON.parse(text);
    expect(file).toMatchObject({ id: rec.value?.id, format: "duo.review-record/1", recorded: { by: "Ada", at: "2026-09-28T00:00:00.000Z" }, review: { verdict: "PASS" }, request: { task: "AUTH-03", from: "HEAD", to: "WORKTREE" } });
    expect(file.diff.identity).toBe(res.diff?.identity);
    expect(file.context.review).toBe(res.context?.review);
    expect(file.claims.map((c: { id: string }) => c.id)).toEqual(res.claims.map((c) => c.id));
    expect(Object.keys(file.claims[0]).sort()).toEqual(["alignment", "basis", "blockEligible", "drift", "enforced", "evidenceIds", "id", "reason", "rule", "semanticCandidate", "subject"]);
    // Pointers only: no source text, no diff lines, no evidence summary.
    expect(text).not.toContain("refresh token expired");
    expect(text).not.toContain("expired refresh token");
    expect(text).not.toContain("summary");
    const hunk = file.evidence.find((e: { basis: string }) => e.basis === "git");
    expect(hunk).toMatchObject({ kind: "diff", contentHash: expect.stringMatching(/^sha256:/u), pointer: { path: "src/auth/token-service.ts", lines: expect.any(Array) } });
    expect(verifyReviewRecord(text).value?.id).toBe(rec.value?.id);
  });

  it("recording the same Review again is a no-op with the same ID (the time is not identity)", async () => {
    const res = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    const one = await recordReview(res, { root: repo.root, actor: human, clock });
    const bytes = fs.readFileSync(path.join(repo.root, one.value?.path ?? ""), "utf8");
    const again = await review(repo, { task: "AUTH-03", diff: W });
    const two = await recordReview(again, { root: repo.root, actor: { kind: "human", name: "Grace" }, clock: () => new Date("2027-01-01T00:00:00Z") });
    expect(two.value).toEqual({ id: one.value?.id, path: one.value?.path, status: "unchanged" });
    expect(recordFiles(repo)).toEqual([(one.value?.id ?? "") + ".json"]);
    expect(fs.readFileSync(path.join(repo.root, one.value?.path ?? ""), "utf8")).toBe(bytes);
    // A different Review is a different record.
    const other = await scenario(repo, () => metricsSort(repo), { task: "AUTH-03", diff: W });
    const three = await recordReview(other, { root: repo.root, actor: human, clock });
    expect(three.value?.id).not.toBe(one.value?.id);
  });

  it("a tampered record under the same ID is never overwritten (integrity error)", async () => {
    const res = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    const one = await recordReview(res, { root: repo.root, actor: human, clock });
    const file = path.join(repo.root, one.value?.path ?? "");
    const tampered = fs.readFileSync(file, "utf8").replace('"verdict": "PASS"', '"verdict": "BLOCK"');
    fs.writeFileSync(file, tampered);
    expect(verifyReviewRecord(tampered).diagnostics.map((d) => d.code)).toEqual(["REVIEW_RECORD_INTEGRITY"]);
    const two = await recordReview(res, { root: repo.root, actor: human, clock });
    expect(two.value).toBeUndefined();
    expect(two.diagnostics.map((d) => d.code)).toEqual(["REVIEW_RECORD_INTEGRITY"]);
    expect(fs.readFileSync(file, "utf8")).toBe(tampered);
  });

  it("only a human records; an index-required Review is not recordable; a symlinked reviews/ is refused", async () => {
    const res = await scenario(repo, aligned, { task: "AUTH-03", diff: W });
    const agent = await recordReview(res, { root: repo.root, actor: { kind: "agent", name: "codex" }, clock });
    expect(agent.diagnostics.map((d) => d.code)).toEqual(["REVIEW_RECORD_FORBIDDEN"]);
    expect(recordFiles(repo)).toEqual([]);
    repo.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
    const stale = await review(repo, { diff: W });
    expect(stale.status).toBe("index-required");
    expect((await recordReview(stale, { root: repo.root, actor: human, clock })).diagnostics.map((d) => d.code)).toEqual(["REVIEW_NOT_RECORDABLE"]);

    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-outside-")));
    temps.push(outside);
    fs.symlinkSync(outside, reviewsDir(repo), "junction");
    try {
      const linked = await recordReview(res, { root: repo.root, actor: human, clock });
      expect(linked.diagnostics.map((d) => d.code)).toEqual(["WRITE_NOT_ALLOWED"]);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(reviewsDir(repo), { recursive: false, force: true });
    }
  });
});

/** Answers every CLAIM with ALIGNED, citing its first evidence ID. */
function fakeProvider(): LLMProvider {
  return {
    id: "fake", status: () => "configured", cacheIdentity: () => "fake:model-1",
    invoke: (r: LLMRequest): Promise<LLMResponse> => {
      const claims = [...r.input.matchAll(/^CLAIM (\S+) .*\n.*\n.*\nevidence: (.*)$/gmu)].map((m) => ({ claim_id: m[1] ?? "", alignment: "ALIGNED", evidence_ids: [(m[2] ?? "").split(", ")[0] ?? ""], reason: "fake" }));
      const value = { claims };
      return Promise.resolve({ status: "success", output: { mode: "structured", text: JSON.stringify(value), value }, usage: { provider: "fake", model: "model-1", inputTokens: 10, outputTokens: 5 } });
    },
  };
}

describe("semantic assistance is a separate supplement (T13.1)", () => {
  it("the deterministic record keeps its ID; the LLM answer is written beside it, never into it", async () => {
    const work = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    work.edit(".duo-project/project.yaml", "current_milestone: M1\n", "current_milestone: M1\nllm:\n  provider: openai-responses\n");
    work.git("commit", "-qam", "enable llm");
    work.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
    await work.index();
    const plain = await review(work, { task: "RPT-01", diff: W });
    const first = await recordReview(plain, { root: work.root, actor: human, clock });
    const assisted = await review(work, { task: "RPT-01", diff: W, includeSemanticAssist: true }, { llm: fakeProvider() });
    expect(assisted.semanticAssist).toMatchObject({ status: "success", provider: { id: "fake", model: "model-1", cacheIdentity: "fake:model-1" } });
    const second = await recordReview(assisted, { root: work.root, actor: human, clock });
    expect(second.value).toMatchObject({ id: first.value?.id, status: "unchanged", assist: { status: "created" } });
    expect(second.value?.assist?.path).toMatch(new RegExp("^\\.duo-project/reviews/" + (first.value?.id ?? "") + "\\.assist-[0-9a-f]{16}\\.json$", "u"));
    const supplement = JSON.parse(fs.readFileSync(path.join(work.root, second.value?.assist?.path ?? ""), "utf8"));
    expect(supplement).toMatchObject({ format: "duo.review-assist/1", review: first.value?.id, provider: { id: "fake" }, claims: [expect.objectContaining({ alignment: "ALIGNED", blockEligible: false })] });
    expect(JSON.stringify(supplement)).not.toMatch(/api[_-]?key|secret/iu);
  });
});

const RATE_LIMITER = "/** Limits requests per user. */\nexport class RateLimiter {\n  allow(userId: string): boolean {\n    return userId.length > 0;\n  }\n}\n";

describe("R-SCOPE: unlinked added application files (T13.1)", () => {
  it("an added application file outside the task and without a Requirement: UNKNOWN drift, WARN, never BLOCK", async () => {
    const res = await scenario(repo, () => repo.write("src/net/rate-limiter.ts", RATE_LIMITER), { task: "AUTH-03", diff: W });
    expect(rows(res)).toEqual(["unlinked-addition src/net/rate-limiter.ts UNKNOWN drift semantic"]);
    expect(res.claims[0]).toMatchObject({ reason: "added-file-unlinked", blockEligible: false, basis: ["repository", "git"] });
    expect(res.verdict).toBe("WARN");
  });

  it("tests, configuration, tooling and docs are not scope findings; without a task nothing is judged", async () => {
    const res = await scenario(repo, () => {
      repo.write("src/net/rate-limiter.test.ts", 'import { it } from "vitest";\nit("allows", () => {});\n');
      repo.write("vitest.config.ts", "export default {};\n");
      repo.write("scripts/release.ts", "export const release = 1;\n");
      repo.write("docs/example.ts", "export const example = 1;\n");
    }, { task: "AUTH-03", diff: W });
    expect(res.claims.filter((c) => c.rule === "unlinked-addition" || c.rule === "scope-relevance")).toEqual([]);
    expect(res.verdict).toBe("PASS");
    const noTask = await scenario(repo, () => repo.write("src/net/rate-limiter.ts", RATE_LIMITER), { diff: W });
    expect(noTask.claims.filter((c) => c.rule === "unlinked-addition")).toEqual([]);
    expect(noTask.limitations.map((l) => l.code)).toContain("no-task-scope");
    expect(["src/a.test.ts", "src/__tests__/a.ts", "vite.config.mts", ".eslintrc.cjs", "scripts/x.ts", "dist/a.js", "docs/a.ts", "src/types.d.ts", ".duo-project/x.ts"].map((p) => nonApplicationReason(p as never)))
      .toEqual(["test", "test", "configuration", "configuration", "tooling", "generated", "documentation", "declaration", "project-truth"]);
    expect(nonApplicationReason("src/net/rate-limiter.ts" as never)).toBeUndefined();
  });

  it("an added file that implements a Requirement is not unlinked; review.warn_on_unlinked_addition: false keeps it UNKNOWN without WARN", async () => {
    const linked = await scenario(repo, () => repo.write("src/net/rate-limiter.ts", "// duo: RPT-01\n" + RATE_LIMITER), { task: "AUTH-03", diff: W });
    expect(linked.claims.filter((c) => c.rule === "unlinked-addition")).toEqual([]);
    const quiet = await scenario(repo, () => {
      repo.edit(".duo-project/project.yaml", "current_milestone: M1\n", "current_milestone: M1\nreview:\n  warn_on_unlinked_addition: false\n");
      repo.write("src/net/rate-limiter.ts", RATE_LIMITER);
    }, { task: "AUTH-03", diff: W });
    expect(quiet.claims.find((c) => c.rule === "unlinked-addition")).toMatchObject({ alignment: "UNKNOWN", drift: false });
    expect(quiet.verdict).toBe("PASS");
  });
});

const README = "# Review App\n\nUsage tooling.\n\n## Tokens\n\nRefresh tokens are stateless.\n\n## Reports\n\nTotals are whole euros.\n";

describe("R-DRIFT: explicit External Source provenance (T13.1)", () => {
  let work: ContextRepo;
  let authMd: string;
  beforeAll(async () => {
    work = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    work.write("README.md", README);
    const slice = externalSourceSlice("README.md", README, "Tokens");
    if (slice.status !== "ok") throw new Error(slice.status);
    work.edit(".duo-project/specs/auth.md", "priority: must\n", "priority: must\nsource:\n  - path: README.md\n    hash: " + slice.hash + "\n    section: Tokens\n");
    work.edit(".duo-project/specs/report.md", "priority: should\n", "priority: should\nsource:\n  - path: https://jira.example.com/browse/RPT-1\n    hash: abc1234\n");
    work.git("add", "-A");
    work.git("commit", "-qm", "provenance");
    await work.index();
    authMd = work.read(".duo-project/specs/auth.md");
  });

  it("the cited section changed: PARTIAL drift, WARN, Truth untouched", async () => {
    const res = await scenario(work, () => work.edit("README.md", "Refresh tokens are stateless.", "Refresh tokens are kept in a server session store."), { diff: W });
    const c = res.claims.find((x) => x.rule === "external-source-drift");
    expect(c).toMatchObject({ subject: { kind: "requirement", id: "AUTH-03" }, alignment: "PARTIAL", reason: "external-source-changed", blockEligible: false });
    expect(res.evidence.find((e) => e.kind === "document" && e.basis === "repository")).toMatchObject({ pointer: { kind: "document", path: "README.md", lines: [5, 9] }, metadata: { section: "Tokens" } });
    expect(res.verdict).toBe("WARN");
    expect(work.read(".duo-project/specs/auth.md")).toBe(authMd);
  });

  it("another section changed: the cited section is unchanged (ALIGNED); a removed heading is PARTIAL", async () => {
    const other = await scenario(work, () => work.edit("README.md", "Totals are whole euros.", "Totals are rounded euros."), { diff: W });
    expect(other.claims.filter((x) => x.rule === "external-source-drift").map((x) => x.subject.id + " " + x.alignment + " " + x.reason)).toEqual(["AUTH-03 ALIGNED external-source-unchanged"]);
    const gone = await scenario(work, () => work.edit("README.md", "## Tokens\n", "## Sessions\n"), { diff: W });
    expect(gone.claims.find((x) => x.rule === "external-source-drift")).toMatchObject({ alignment: "PARTIAL", reason: "external-section-missing" });
  });

  it("a remote source (URL, Jira) is never guessed at: external-source-unavailable, no drift claim", async () => {
    const res = await scenario(work, () => work.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)"), { task: "RPT-01", diff: W });
    expect(res.claims.filter((x) => x.rule === "external-source-drift")).toEqual([]);
    const l = res.limitations.find((x) => x.code === "external-source-unavailable");
    expect(l?.message).toContain("RPT-01");
    expect(l?.message).not.toContain("jira.example.com");
  });

  it("unrelated changes do not check provenance at all", async () => {
    const res = await scenario(work, () => metricsSort(work), { diff: W });
    expect(res.claims.filter((x) => x.rule === "external-source-drift")).toEqual([]);
    expect(res.limitations.map((x) => x.code)).not.toContain("external-source-unavailable");
  });
});

