import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject, snapshot } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

describe("Existing Project Adoption through the CLI (T15, subprocess)", () => {
  const p = existingProject(temps);
  const reviews = () => { const d = path.join(p.root, ".duo-project", "reviews"); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };
  const metrics = () => fs.readFileSync(path.join(p.root, ".duo-project", "runtime", "metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  it("init: minimal Truth, initial index, adoption baseline; sparse Truth is normal", () => {
    const r = duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }]));
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ format: "duo.cli.init/1", ok: true, exitCode: 0 });
    expect(out.result.steps).toMatchObject({ repository: { status: "ok" }, truth: { status: "ok" }, index: { status: "ok" }, baseline: { status: "ok" } });
    expect(out.result.plan.observed).toMatchObject({ name: { value: "orbit-tasks" }, git: { branch: "develop" }, workingTree: { dirty: false } });
    expect(out.result.plan.observed.sourceRoots[0].files).toBeGreaterThanOrEqual(30);
    expect(out.result.index).toMatchObject({ mode: "full", fullRebuildReason: "no-state" });
    expect(out.result.baseline).toMatchObject({ status: "captured", dirtyAtAdoption: false, findings: 0 });
    expect(reviews()).toEqual([expect.stringMatching(/^adoption-[0-9a-f]{16}\.json$/u)]);
    expect(out.result.apply.openQuestions).toEqual(["current_milestone", "critical_constraints"]);
  });

  it("status is read-only and shows a current index and baseline; a code change makes it stale", () => {
    const before = snapshot(p.root);
    const s = duoctl(p.root, ["status", "--json"]);
    expect(s.code).toBe(0);
    expect(snapshot(p.root)).toEqual(before);
    expect(s.json()).toMatchObject({ format: "duo.cli.status/1", result: {
      initialized: true, truth: { requirements: 0, decisions: 0, constraints: 0 }, index: { status: "current" }, baseline: { status: "current" }, pendingDecisions: [], llm: "disabled",
    } });
    p.edit("src/scheduler.ts", "% 7", "% 5");
    const stale = duoctl(p.root, ["status", "--json"]).json();
    expect(stale.result.index).toMatchObject({ status: "stale", changes: { files: 1, analysisStale: 1 } });
  });

  it("a stale review is index-required (exit 6) and writes no record; index, context and review then work", () => {
    const stale = duoctl(p.root, ["review", "--json"]);
    expect(stale.code).toBe(6);
    expect(stale.json().result.review.status).toBe("index-required");
    const idx = duoctl(p.root, ["index", "--json"]);
    expect(idx.code).toBe(0);
    expect(idx.json().result).toMatchObject({ mode: "incremental", fullRebuildReason: null });
    const ctx = duoctl(p.root, ["context", "Scheduler.next", "--json"]);
    expect(ctx.code).toBe(0);
    expect(ctx.json()).toMatchObject({ format: "duo.cli.context/1", result: { status: "ready", packet: { format: "duo.context-packet/1" } } });
    const md = duoctl(p.root, ["context", "Scheduler.next"]);
    expect(md.stdout).toContain("# DUO CONTEXT PACKET");
    const rv = duoctl(p.root, ["review", "--json"]);
    expect(rv.code).toBe(0);
    const review = rv.json().result.review;
    expect(review).toMatchObject({ format: "duo.review/1", status: "ready", baseline: { status: "present" }, metrics: { llmCalls: 0 } });
    expect(["PASS", "WARN", "ASK", "BLOCK"]).toContain(review.verdict);
    expect(review.diff.files.map((f: { path: string }) => f.path)).toContain("src/scheduler.ts");
    expect(reviews().filter((f) => f.startsWith("review-"))).toEqual([]); // no automatic record
    const human = duoctl(p.root, ["review", "--task", "Scheduler.next"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^(PASS|WARN|ASK|BLOCK) /mu);
  });

  it("review exit codes follow the verdict only with --fail-on; --record writes one Review Record", () => {
    const rv = duoctl(p.root, ["review", "--json"]).json().result.review;
    const failing = duoctl(p.root, ["review", "--fail-on", "warn"]);
    expect(failing.code).toBe(({ PASS: 0, WARN: 2, ASK: 3, BLOCK: 4 } as Record<string, number>)[rv.verdict]);
    expect(duoctl(p.root, ["review", "--fail-on", "block"]).code).toBe(rv.verdict === "BLOCK" ? 4 : 0);
    const rec = duoctl(p.root, ["review", "--record", "--json"]);
    expect(rec.code).toBe(0);
    expect(rec.json().result.record).toMatchObject({ status: "created", path: expect.stringMatching(/^\.duo-project\/reviews\/review-/u) });
    expect(duoctl(p.root, ["review", "--record", "--json"]).json().result.record.status).toBe("unchanged");
    expect(reviews().filter((f) => f.startsWith("review-"))).toHaveLength(1);
  });

  it("trace and impact expose bounded Graph results; decision commands need a terminal", () => {
    const tr = duoctl(p.root, ["trace", "src/scheduler.ts", "--json"]);
    expect(tr.code).toBe(0);
    expect(tr.json().result).toMatchObject({ node: { type: "file", path: "src/scheduler.ts" }, truncated: false });
    const im = duoctl(p.root, ["impact", "Scheduler.next", "--depth", "2", "--json"]);
    expect(im.code).toBe(0);
    expect(im.json().result).toMatchObject({ evidence: "graph", truncated: expect.any(Boolean) });
    expect(im.json().result.items.map((i: { id: string }) => i.id)).toContain("file:src/reminder.ts");
    expect(duoctl(p.root, ["impact", "NoSuchThing"]).code).toBe(1);
    expect(duoctl(p.root, ["decision", "list", "--json"]).json().result.pending).toEqual([]);
    const confirm = duoctl(p.root, ["decision", "confirm", "P-001", "--json"]);
    expect(confirm.code).toBe(1);
    expect(confirm.json().diagnostics.map((d) => d.code)).toEqual(["CLI_TTY_REQUIRED"]);
  });

  it("index --full is a requested clean rebuild; metrics.jsonl holds structured entries only, llm calls 0", () => {
    expect(duoctl(p.root, ["index", "--full", "--json"]).json().result).toMatchObject({ mode: "full", fullRebuildReason: "requested" });
    const m = metrics();
    expect(m.map((x) => x.command)).toEqual(expect.arrayContaining(["init", "review", "index", "context"]));
    expect(m.every((x) => x.format === "duo.metric/1" && typeof x.durationMs === "number")).toBe(true);
    expect(m.filter((x) => "llmCalls" in x).every((x) => x.llmCalls === 0)).toBe(true);
    const raw = fs.readFileSync(path.join(p.root, ".duo-project", "runtime", "metrics.jsonl"), "utf8");
    expect(raw).not.toContain("Scheduler.next"); // no task text
    expect(raw).not.toContain("% 5"); // no source or diff text
    expect(m.some((x) => x.command === "status" || x.command === "trace" || x.command === "impact")).toBe(false);
    const stats = duoctl(p.root, ["stats", "--json"]).json();
    expect(stats.result.llm.calls).toBe(0);
  });
});

describe("dirty existing project (T15, subprocess)", () => {
  const p = existingProject(temps);
  p.edit("src/reminder.ts", "\"member-\"", "\"person-\"");
  p.write("src/holidays.ts", "export const HOLIDAYS: readonly number[] = [];\n");

  it("dirty is detected; without a policy (and with --yes) init stops at the baseline; Truth and index stay", () => {
    const r = duoctl(p.root, ["init", "--non-interactive", "--json"]);
    expect(r.code).toBe(6);
    const out = r.json();
    expect(out.result.plan.observed.workingTree).toMatchObject({ dirty: true, unstaged: ["src/reminder.ts"], untracked: ["src/holidays.ts"] });
    expect(out.result.steps).toMatchObject({ truth: { status: "ok" }, index: { status: "ok" }, baseline: { status: "action-required" } });
    expect(out.diagnostics.map((d) => d.code)).toContain("ADOPTION_DIRTY_POLICY_REQUIRED");
    const yes = duoctl(p.root, ["init", "--non-interactive", "--yes", "--json"]);
    expect(yes.code).toBe(6);
    expect(yes.json().result.steps).toMatchObject({ truth: { status: "existing" }, index: { status: "existing" }, baseline: { status: "action-required" } });
    const abort = duoctl(p.root, ["init", "--non-interactive", "--baseline-policy", "abort", "--json"]);
    expect(abort.code).toBe(6);
    expect(abort.json().result.steps.baseline.status).toBe("aborted");
    expect(fs.existsSync(path.join(p.root, ".duo-project", "reviews")) ? fs.readdirSync(path.join(p.root, ".duo-project", "reviews")) : []).toEqual([]);
  });

  it("HEAD_BASELINE adopts at HEAD; the dirty changes stay visible to the next Review", () => {
    const r = duoctl(p.root, ["init", "--non-interactive", "--baseline-policy", "head", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().result.baseline).toMatchObject({ status: "captured", dirtyAtAdoption: true });
    const status = duoctl(p.root, ["status", "--json"]).json();
    expect(status.result.baseline).toMatchObject({ status: "current", dirtyAtAdoption: true });
    const rv = duoctl(p.root, ["review", "--json"]).json().result.review;
    expect(rv.diff.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["src/holidays.ts", "src/reminder.ts"]));
  });
});
