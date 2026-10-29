import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
import { withIndexWriteLock } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMProviderPool } from "../../packages/integration/src/llm/factory.js";
import { TOOLS, type WorkActivityStore } from "../../packages/integration/src/mcp/tools.js";
import { completeWorkTask, touchWorkTask } from "../../packages/integration/src/http/work-map.js";
import { CLI_MAIN, duoctl, existingProject, snapshot } from "../cli/support.js";
import { contextRegistry, makeContextRepo, REVIEW_FIXTURE } from "../../packages/director/src/context/testing.js";
import { startMcp, type McpSession } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
const sessions: McpSession[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});
const open = async (root: string) => { const s = await startMcp(root); sessions.push(s); return s; };

const TOOL_NAMES = [
  "duo_get_context", "duo_get_decision", "duo_get_requirement", "duo_get_status", "duo_impact",
  "duo_propose_decision", "duo_review_changes", "duo_search_evidence", "duo_trace",
];

describe("duo-director MCP: protocol, tool list as the permission contract, argument errors (TASK-016)", () => {
  const p = existingProject(temps);

  it("initialize, tools/list: exactly the nine tools, no confirm / reject / write / index / record tool", async () => {
    const s = await open(p.root);
    expect(s.client.getServerVersion()).toMatchObject({ name: "duo-director" });
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect(tools.some((t) => /confirm|reject|record|index|write|baseline|capture/u.test(t.name))).toBe(false);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false); // strict: unknown fields are refused
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations).toEqual({
        readOnlyHint: !["duo_get_context", "duo_review_changes", "duo_propose_decision"].includes(t.name),
        destructiveHint: ["duo_get_context", "duo_review_changes"].includes(t.name),
        idempotentHint: !["duo_get_context", "duo_review_changes", "duo_propose_decision"].includes(t.name),
        openWorldHint: false,
      });
    }
    const describe = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    // #4: the maintainer-approved contract for the automatic refresh.
    const refreshContract = "Does not modify Project Truth or source code. When the index is stale and it is safe, refreshes DUO's regenerable index once and says so in the result.";
    expect(describe("duo_get_context")).toContain(refreshContract);
    expect(describe("duo_get_context")).toMatch(/Appends a local runtime metric.*cannot be refreshed safely, returns status index-required with the reason/su);
    expect(describe("duo_review_changes")).toContain(refreshContract);
    expect(describe("duo_review_changes")).toContain("cannot be refreshed safely, returns status index-required with the reason");
    expect(describe("duo_review_changes")).toContain("Appends a local runtime metric");
    expect(describe("duo_review_changes")).toContain("does not persist a formal Review Record");
    expect(describe("duo_propose_decision")).toMatch(/proposal only.*Cannot confirm or reject a decision/su);
  });

  it("a repository without DUO is a normal not-initialized result, and reading it writes nothing", async () => {
    const s = await open(p.root);
    const before = snapshot(p.root);
    const r = await s.call("duo_get_status");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ format: "duo.not-initialized/1", status: "not-initialized" });
    expect((await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent.status).toBe("not-initialized");
    expect(snapshot(p.root)).toEqual(before);
  });

  it("invalid arguments are tool errors: unknown fields, bad ranges, paths outside the repository, unknown tools", async () => {
    const s = await open(p.root);
    const bad: [string, Record<string, unknown>][] = [
      ["duo_get_context", {}],
      ["duo_get_context", { task: "x", extra: true }],
      ["duo_get_context", { task: "x", budget: 5 }],
      ["duo_trace", { node: "src/scheduler.ts", depth: 9 }],
      ["duo_get_requirement", { id: "../../etc/passwd" }],
      ["duo_review_changes", { files: ["../outside.ts"] }],
      ["duo_review_changes", { files: ["C:/Windows/win.ini"] }],
      ["duo_review_changes", { from: "--output=/tmp/x" }],
      ["duo_propose_decision", { title: "t", question: "q", answer: "a", governs: { paths: ["../**"] } }],
      ["duo_get_status", { root: "/elsewhere" }],
    ];
    for (const [name, args] of bad) {
      const r = await s.call(name, args).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    for (const name of ["duo_confirm_decision", "duo_reject_decision", "duo_record_review", "duo_index"]) {
      const r = await s.call(name, {}).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      expect(r.isError).toBe(true);
    }
  });

  it("the root must be the top level of a Git work tree; stdout stays empty when the server cannot start", () => {
    const sub = duoctl(p.root, ["mcp", "--root", path.join(p.root, "src")]);
    expect(sub.code).toBe(1);
    expect(sub.stdout).toBe("");
    expect(sub.stderr).toContain("SCAN_ROOT_INVALID");
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-nogit-")));
    temps.push(plain);
    const none = duoctl(plain, ["mcp", "--root", plain]);
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("GIT_REPOSITORY_REQUIRED");
  });

  it("the server exits when the client closes stdin", async () => {
    const child = spawn(process.execPath, [CLI_MAIN, "mcp", "--root", p.root], { cwd: p.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20_000))]);
    if (code === "timeout") child.kill();
    expect(code).toBe(0);
    expect(out).toBe(""); // nothing but protocol on stdout, and no request was sent
  });
});

describe("existing project through MCP: freshness, CLI parity, WAL, metrics, propose-only (TASK-016)", () => {
  const p = existingProject(temps);
  let s: McpSession;
  const cli = (args: string[]) => {
    const r = duoctl(p.root, [...args, "--json"]);
    return r.json().result as unknown;
  };
  beforeAll(async () => {
    const init = duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }]));
    expect(init.code).toBe(0);
    s = await open(p.root);
  });

  it("status, context, review, trace and impact: structuredContent equals the CLI --json result", async () => {
    const pairs: [string, Record<string, unknown>, string[]][] = [
      ["duo_get_status", {}, ["status"]],
      ["duo_get_context", { task: "Scheduler.next" }, ["context", "Scheduler.next"]],
      ["duo_review_changes", {}, ["review"]],
      ["duo_review_changes", { task: "Scheduler.next" }, ["review", "--task", "Scheduler.next"]],
      ["duo_trace", { node: "src/scheduler.ts" }, ["trace", "src/scheduler.ts"]],
      ["duo_impact", { node: "Scheduler.next", depth: 2 }, ["impact", "Scheduler.next", "--depth", "2"]],
    ];
    for (const [tool, args, command] of pairs) {
      const r = await s.call(tool, args);
      expect(r.isError, tool).toBeFalsy();
      expect(r.structuredContent, tool).toEqual(cli(command));
      expect(r.content[0]?.type).toBe("text");
    }
    const status = (await s.call("duo_get_status")).structuredContent;
    expect(status).toMatchObject({ format: "duo.status/1", initialized: true, index: { status: "current" }, baseline: { status: "current" }, pendingDecisions: [], llm: "disabled" });
    const ctx = (await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent;
    expect(ctx).toMatchObject({ format: "duo.context/1", status: "ready", context: { packet: { format: "duo.context-packet/1" } } });
    expect(typeof ctx.gaps.requiresHumanInput).toBe("boolean");
    expect(ctx.gaps.notice).toMatch(/not confirmed instructions/u);
    const activity = JSON.parse(fs.readFileSync(path.join(p.root, ".duo-project", "runtime", "work-tasks.json"), "utf8")) as { tasks: { agent: string; name: string }[] };
    expect(activity.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Scheduler.next" })]));
    const missing = await s.call("duo_trace", { node: "NoSuchThing" });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({ format: "duo.trace/1", status: "not-found" });
  });

  it("#4: duo_get_context refreshes a stale index once, answers, says so, and writes only regenerable state", async () => {
    p.edit("src/scheduler.ts", "% 7", "% 5");
    const before = snapshot(p.root);
    expect((await s.call("duo_get_status")).structuredContent.index).toMatchObject({ status: "stale", changes: { files: 1 } });
    const ctx = await s.call("duo_get_context", { task: "Scheduler.next" });
    expect(ctx.isError).toBeFalsy();
    expect(ctx.structuredContent).toMatchObject({ status: "ready", indexRefresh: { refreshed: true } });
    expect(ctx.content[0]?.text).toContain("The DUO index was stale; DUO refreshed it once before answering.");
    expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
    // Only DUO's regenerable state (generated/, cache/, runtime/) changed: no Project Truth, no source, nothing else.
    const regenerable = /^\.duo-project[\\/](?:generated|cache|runtime)[\\/]/u;
    const outside = (items: ReturnType<typeof snapshot>) => items.filter(([f]) => !regenerable.test(f));
    expect(outside(snapshot(p.root))).toEqual(outside(before));
    // A current index is read as it is: no second refresh and no indexRefresh field.
    const again = (await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent;
    expect(again.status).toBe("ready");
    expect(again.indexRefresh).toBeUndefined();
    const ready = (await s.call("duo_review_changes", {})).structuredContent;
    expect(ready).toMatchObject({ format: "duo.review/1", status: "ready", metrics: { llmCalls: 0 } });
    expect(ready.indexRefresh).toBeUndefined();
    expect(ready.diff.files.map((f: { path: string }) => f.path)).toContain("src/scheduler.ts");
    // The explicit CLI index still works on the refreshed index while this server runs.
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
  });

  // #4: the README commit step moves HEAD without changing a file; that used to stop MCP reads until someone ran duoctl index.
  it("#4: duo_review_changes refreshes once after HEAD moves with no file change, and answers with the same note", async () => {
    p.git("commit", "-q", "--allow-empty", "-m", "move HEAD only");
    expect((await s.call("duo_get_status")).structuredContent.index).toMatchObject({ status: "stale", changes: { files: 0 } });
    const rv = await s.call("duo_review_changes", {});
    expect(rv.isError).toBeFalsy();
    expect(rv.structuredContent).toMatchObject({ format: "duo.review/1", status: "ready", indexRefresh: { refreshed: true } });
    expect(rv.content[0]?.text).toContain("The DUO index was stale; DUO refreshed it once before answering.");
    expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
  });

  it("#4: two MCP servers reading a stale index at the same time refresh it once and leave one valid index", async () => {
    const other = await open(p.root);
    p.edit("src/scheduler.ts", "% 5", "% 3");
    const both = await Promise.all([s.call("duo_get_context", { task: "Scheduler.next" }), other.call("duo_get_context", { task: "Scheduler.next" })]);
    // The common writer lock lets exactly one refresh. The other read finds the index current after waiting (refreshed: false),
    // reads it current, or gives up after the 5 s lock wait with the lock-timeout reason (a refresh can take longer on Windows).
    const refreshed = both.filter((r) => r.structuredContent.indexRefresh?.refreshed === true);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.structuredContent.status).toBe("ready");
    for (const r of both.filter((x) => x !== refreshed[0])) {
      const c = r.structuredContent;
      if (c.status === "index-required") expect(c.indexRefresh.reason).toContain("Index lock timeout");
      else expect(c.status).toBe("ready");
    }
    expect((await other.call("duo_get_status")).structuredContent.index.status).toBe("current");
    expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
  });

  it("#4: an index that cannot be refreshed safely keeps index-required with the reason (lock timeout, missing index)", async () => {
    p.edit("src/scheduler.ts", "% 3", "% 2");
    // Another writer holds the common index lock longer than a read waits for it.
    const held = await withIndexWriteLock(p.root, async () => {
      const ctx = await s.call("duo_get_context", { task: "Scheduler.next" });
      expect(ctx.structuredContent).toMatchObject({ status: "index-required", indexRefresh: { refreshed: false } });
      expect(ctx.structuredContent.indexRefresh.reason).toMatch(/lock/iu);
      expect(ctx.content[0]?.text).toMatch(/duoctl index.*Automatic index refresh was not done: /su);
      const rv = await s.call("duo_review_changes", {});
      expect(rv.structuredContent).toMatchObject({ status: "index-required", indexRefresh: { refreshed: false } });
      expect(rv.content[0]?.text).toContain("Automatic index refresh was not done: ");
    });
    expect(held.diagnostics).toEqual([]);
    // A read never bootstraps a missing index.
    const db = path.join(p.root, ".duo-project", "generated", "graph.db");
    for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
    const missing = (await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent;
    expect(missing).toMatchObject({ status: "index-required", indexRefresh: { refreshed: false } });
    expect(missing.indexRefresh.reason).toContain("existing compatible index");
    expect(fs.existsSync(db)).toBe(false);
    // The explicit CLI still builds it.
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    expect((await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent.status).toBe("ready");
  });

  it("no reader is left open between tool calls: a full rebuild and a WAL checkpoint succeed while the server runs", async () => {
    await s.call("duo_get_context", { task: "Scheduler.next" });
    await s.call("duo_impact", { node: "Scheduler.next" });
    const full = duoctl(p.root, ["index", "--full", "--json"]);
    expect(full.code).toBe(0);
    expect(full.json().result).toMatchObject({ mode: "full", fullRebuildReason: "requested" });
    // A TRUNCATE checkpoint needs every reader gone; it fails as busy while a snapshot is pinned.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(p.root, ".duo-project", "generated", "graph.db"));
    try {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number };
      expect(row.busy).toBe(0);
    } finally {
      db.close();
    }
    expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
  });

  it("propose is the only Project Truth write: P-001 is pending, and nothing can confirm it", async () => {
    const r = await s.call("duo_propose_decision", {
      title: "Weekday rotation", question: "Should the rotation skip weekends?", answer: "Yes, weekdays only.", governs: { paths: ["src/scheduler.ts"] }, agent: "codex",
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ format: "duo.proposal/1", proposalId: "P-001", confirmed: false, proposedBy: { kind: "agent", name: "codex" } });
    expect(fs.existsSync(path.join(p.root, r.structuredContent.path))).toBe(true);
    expect((await s.call("duo_get_status")).structuredContent.pendingDecisions.map((d: { id: string }) => d.id)).toEqual(["P-001"]);
    expect((await s.call("duo_get_decision", { id: "P-001" })).structuredContent).toMatchObject({ format: "duo.decision/1", status: "not-found", note: expect.stringContaining("proposal") });
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /confirm|reject/u.test(n))).toEqual([]);
    expect(duoctl(p.root, ["decision", "list", "--json"]).json().result.pending.map((d: { id: string }) => d.id)).toEqual(["P-001"]);
    expect((await s.call("duo_search_evidence", { query: "scheduler" })).structuredContent.candidates.length).toBeGreaterThan(0);
  });

  it("metrics: context, review and proposal append structured entries without task or source text", () => {
    const raw = fs.readFileSync(path.join(p.root, ".duo-project", "runtime", "metrics.jsonl"), "utf8");
    const m = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((x) => x.surface === "mcp");
    expect(new Set(m.map((x) => x.command))).toEqual(new Set(["duo_get_context", "duo_review_changes", "duo_propose_decision"]));
    expect(m.every((x) => x.format === "duo.metric/1" && typeof x.durationMs === "number" && typeof x.status === "string")).toBe(true);
    expect(m.filter((x) => "llmCalls" in x).every((x) => x.llmCalls === 0)).toBe(true);
    expect(m.some((x) => x.command === "duo_review_changes" && x.status === "index-required")).toBe(true);
    expect(raw).not.toContain("Scheduler.next");
    expect(raw).not.toContain("weekdays only");
    expect(raw).not.toContain("% 5");
  });
});

describe("Work map activity does not change MCP results", () => {
  const p = existingProject(temps);
  let s: McpSession;
  const activity = path.join(p.root, ".duo-project", "runtime", "work-tasks.json");
  beforeAll(async () => {
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"],
      JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }])).code).toBe(0);
    s = await open(p.root);
  });

  it("preserves successful context and review responses when activity storage is malformed or unreadable", async () => {
    fs.mkdirSync(path.dirname(activity), { recursive: true });
    fs.writeFileSync(activity, "{malformed", "utf8");
    const malformedBefore = fs.readFileSync(activity, "utf8");
    const context = await s.call("duo_get_context", { task: "Scheduler.next" });
    expect(context.isError).toBeFalsy();
    expect(context.structuredContent).toEqual(duoctl(p.root, ["context", "Scheduler.next", "--json"]).json().result);
    expect(fs.readFileSync(activity, "utf8")).toBe(malformedBefore);

    fs.rmSync(activity);
    fs.mkdirSync(activity);
    const review = await s.call("duo_review_changes", { task: "Scheduler.next" });
    expect(review.isError).toBeFalsy();
    expect(review.structuredContent).toEqual(duoctl(p.root, ["review", "--task", "Scheduler.next", "--json"]).json().result);
    expect(fs.statSync(activity).isDirectory()).toBe(true);
    fs.rmSync(activity, { recursive: true });
  });

  it("returns a successful context when the activity lock is held and records bounded wait time", async () => {
    const lock = path.join(path.dirname(activity), "work-tasks.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held by test", "utf8");
    try {
      const result = await s.call("duo_get_context", { task: "Lock contention task" });
      expect(result.isError).toBeFalsy();
      const timing = s.stderr().match(/duo work activity task failed after (\d+) ms: Timed out waiting for work task lock after \d+ ms \(limit 100 ms\)/u);
      expect(timing).not.toBeNull();
      expect(Number(timing?.[1])).toBeLessThan(1000);
    } finally { fs.rmSync(lock, { force: true }); }
  });

  it("keeps MCP results when task writes, review writes, or diagnostic logging fail", async () => {
    const base = { root: p.root, agentName: "Codex", duoSessionId: "failure-injection-session",
      signal: new AbortController().signal, llm: new LLMProviderPool({}), log: () => { throw new Error("simulated logger failure"); } };
    const failedTaskStore: WorkActivityStore = {
      touch: () => { throw new Error("simulated task write failure"); },
      review: () => { throw new Error("review should be skipped without a task ID"); },
    };
    const context = await TOOLS.duo_get_context.run({ task: "Scheduler.next" }, { ...base, workActivity: failedTaskStore });
    expect(context.op.kind).toBe("ok");

    const failedReviewStore: WorkActivityStore = {
      touch: (root, agent, task, now, identity, wait) => touchWorkTask(root, agent, task, now, identity, wait),
      review: () => { throw new Error("simulated review write failure"); },
    };
    const review = await TOOLS.duo_review_changes.run({ task: "Scheduler.next" }, { ...base, workActivity: failedReviewStore });
    expect(review.op.kind).toBe("ok");
  });

  it("does not create sessionless activity and retains concurrent writes from separate MCP sessions", async () => {
    let sessionlessWrites = 0;
    const noSessionStore: WorkActivityStore = {
      touch: () => { sessionlessWrites += 1; return undefined; }, review: () => { sessionlessWrites += 1; },
    };
    const noSession = await TOOLS.duo_get_context.run({ task: "Scheduler.next" }, {
      root: p.root, agentName: "Codex", signal: new AbortController().signal, llm: new LLMProviderPool({}), workActivity: noSessionStore,
    });
    expect(noSession.op.kind).toBe("ok");
    expect(sessionlessWrites).toBe(0);

    const second = await open(p.root);
    const [left, right] = await Promise.all([
      s.call("duo_get_context", { task: "Parallel session task alpha" }),
      second.call("duo_get_context", { task: "Parallel session task beta" }),
    ]);
    expect(left.isError).toBeFalsy();
    expect(right.isError).toBeFalsy();
    const rows = (JSON.parse(fs.readFileSync(activity, "utf8")) as { tasks: { name: string; duoSessionId?: string }[] }).tasks
      .filter((task) => task.name.startsWith("Parallel session task"));
    expect(rows.map((task) => task.name).sort()).toEqual(["Parallel session task alpha", "Parallel session task beta"]);
    expect(new Set(rows.map((task) => task.duoSessionId)).size).toBe(2);
  });

  it("attaches free-form reviews by session and full task identity, even when display names match", async () => {
    const first = "Investigate an unmapped workflow\nvariant alpha";
    const second = "Investigate an unmapped workflow\nvariant beta";
    expect((await s.call("duo_get_context", { task: first })).isError).toBeFalsy();
    expect((await s.call("duo_get_context", { task: second })).isError).toBeFalsy();
    const tasks = () => (JSON.parse(fs.readFileSync(activity, "utf8")) as { tasks: {
      id: string; name: string; targetRef?: string; taskKey?: string; review?: { digest: string; verdict?: string };
    }[] }).tasks.filter((t) => t.name === "Investigate an unmapped workflow");
    expect(tasks()).toHaveLength(2);
    expect(new Set(tasks().map((t) => t.id)).size).toBe(2);
    expect(new Set(tasks().map((t) => t.taskKey)).size).toBe(2);
    expect(tasks().every((t) => t.targetRef === undefined)).toBe(true);

    const reviewed = await s.call("duo_review_changes", { task: second });
    expect(reviewed.isError).toBeFalsy();
    expect(tasks().filter((t) => t.review !== undefined)).toHaveLength(1);
    const secondKey = tasks().find((t) => t.review !== undefined)?.taskKey;
    expect(secondKey).toBe(tasks()[1]?.taskKey);
    const secondReview = tasks().find((t) => t.taskKey === secondKey)?.review;
    expect(secondReview?.digest).toBe(reviewed.structuredContent.diff.identity);
    expect(secondReview?.verdict).toBe(reviewed.structuredContent.verdict);
    expect((await s.call("duo_review_changes", { task: first })).isError).toBeFalsy();
    expect(tasks().every((t) => t.review !== undefined)).toBe(true);
    const firstReviewResult = await s.call("duo_review_changes", { task: first });
    expect(firstReviewResult.isError).toBeFalsy();
    const firstKey = tasks().find((t) => t.id !== tasks().find((x) => x.taskKey === secondKey)?.id)?.taskKey;
    expect(tasks().find((t) => t.taskKey === firstKey)?.review?.digest).toBe(firstReviewResult.structuredContent.diff.identity);
  });

  it("updates a repeated active task ID and creates a fresh ID when completed work restarts", async () => {
    const text = "Restartable free-form task\nkeep this detail";
    await s.call("duo_get_context", { task: text });
    const lookup = () => (JSON.parse(fs.readFileSync(activity, "utf8")) as { tasks: { id: string; taskKey?: string; name: string; status: string }[] })
      .tasks.filter((task) => task.name === "Restartable free-form task");
    const firstId = lookup()[0]?.id;
    await s.call("duo_get_context", { task: text });
    expect(lookup().filter((task) => task.status === "active")).toHaveLength(1);
    expect(lookup()[0]?.id).toBe(firstId);
    expect(completeWorkTask(p.root, firstId ?? "", new Date())?.status).toBe("completed");
    await s.call("duo_get_context", { task: text });
    expect(lookup().map((task) => task.status).sort()).toEqual(["active", "completed"]);
    expect(new Set(lookup().map((task) => task.id)).size).toBe(2);
  });
});

describe("Truth lookups and dirty-baseline Review provenance through MCP (TASK-016)", () => {
  const LEGACY = "/** Kept from before DUO. */\nexport class LegacySessionStore {\n  private readonly sessions = new Map<string, string>();\n\n  save(token: string, userId: string): void {\n    this.sessions.set(token, userId);\n  }\n}\n";
  const SERVER = "export class ServerSessionStore {\n  keep(token: string): string {\n    return token;\n  }\n}\n";
  let root = "";
  let s: McpSession;
  beforeAll(async () => {
    const registry = await contextRegistry();
    try {
      const repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
      repo.write("src/auth/legacy-session-store.ts", LEGACY);
      repo.git("add", "-A");
      repo.git("commit", "-qm", "legacy store");
      repo.edit("src/auth/legacy-session-store.ts", "this.sessions.set(token, userId);", "this.sessions.set(token, userId.trim());");
      repo.write("src/auth/server-session-store.ts", SERVER);
      root = repo.root;
    } finally {
      registry.dispose();
    }
    // An initialized project without a baseline, dirty: the human chooses HEAD_BASELINE in the CLI.
    const init = duoctl(root, ["init", "--non-interactive", "--baseline-policy", "head", "--json"]);
    expect(init.code).toBe(0);
    expect(init.json().result.baseline).toMatchObject({ status: "captured", dirtyAtAdoption: true });
    s = await open(root);
  });

  it("duo_get_requirement and duo_get_decision return one definition or a typed not-found", async () => {
    const req = (await s.call("duo_get_requirement", { id: "AUTH-03" })).structuredContent;
    expect(req).toMatchObject({ format: "duo.requirement/1", status: "found", id: "AUTH-03" });
    expect(typeof req.text).toBe("string");
    expect(req.text).toContain("AUTH-03");
    expect((await s.call("duo_get_requirement", { id: "NOPE-99" })).structuredContent).toMatchObject({ status: "not-found", id: "NOPE-99" });
    const dec = (await s.call("duo_get_decision", { id: "D-004" })).structuredContent;
    expect(dec).toMatchObject({ format: "duo.decision/1", status: "found", id: "D-004" });
    expect(dec.decision).toMatchObject({ state: expect.any(String) });
    expect((await s.call("duo_search_evidence", { query: "D-004" })).structuredContent.candidates.some((c: { id?: string; ref?: string }) => c.id === "D-004" || c.ref === "D-004")).toBe(true);
  });

  it("duo_review_changes returns the same provenance and verdict as the CLI; BLOCK is a normal result", async () => {
    const r = await s.call("duo_review_changes", { task: "AUTH-03" });
    expect(r.isError).toBeFalsy();
    const viaCli = duoctl(root, ["review", "--task", "AUTH-03", "--json"]).json().result;
    expect(r.structuredContent).toEqual(viaCli);
    const forbids = r.structuredContent.claims.filter((c: { rule: string }) => c.rule === "decision-forbids");
    const byFile = (f: string) => forbids.filter((c: { observed: string }) => c.observed.includes(f)).map((c: { provenance: string; blockEligible: boolean }) => [c.provenance, c.blockEligible]);
    expect(byFile("legacy-session-store.ts")).toEqual([["pre-existing-touched", false]]);
    expect(byFile("server-session-store.ts")).toEqual([["introduced", true]]);
    expect(r.structuredContent.verdict).toBe("BLOCK");
    // H-73 (C240): people read adoption-baseline wording; the machine values above are unchanged.
    const summary = String(r.content[0]?.text);
    // C241 (T49): a Decision claim's tags also carry its lifecycle.
    expect(summary).toContain("(not-in-adoption-baseline) [blocking; current authority]");
    expect(summary).toContain("(in-adoption-baseline, touched) [current authority]");
    expect(summary).not.toMatch(/\((?:introduced|pre-existing|pre-existing-touched)\)/u);
    const human = duoctl(root, ["review", "--task", "AUTH-03"]).stdout;
    expect(human).toContain("[blocking, not-in-adoption-baseline]");
    expect(human).toContain("[in-adoption-baseline, touched]");
    expect(human).not.toMatch(/\[[^\]]*(?:introduced|pre-existing)[^\]]*\]/u);
    const truth = r.structuredContent.diff.files.filter((f: { path: string }) => f.path.startsWith(".duo-project/"));
    expect(truth.every((f: { provenance?: string }) => f.provenance === "adoption-bootstrap")).toBe(true);
  });
});
describe("H-71 full decision proposals through MCP: more expressive, no authority until a human confirms (T35.1)", () => {
  const p = existingProject(temps);
  let s: McpSession;
  const human = { kind: "human" as const, name: "Ada Lovelace" };
  const decisionFiles = () => fs.readdirSync(path.join(p.root, ".duo-project", "decisions")).filter((f) => f.endsWith(".yaml")).sort();
  const proposalFiles = () => { const d = path.join(p.root, ".duo-project", "decisions", "proposals"); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };
  const readD = (id: string) => fs.readFileSync(path.join(p.root, ".duo-project", "decisions", `${id}.yaml`), "utf8");
  beforeAll(async () => {
    const init = duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }]));
    expect(init.code).toBe(0);
    s = await open(p.root);
  });

  it("A-O: old and full proposals, validation with no write, unchanged verdict and Decisions, and no agent path to authority", async () => {
    const review = async () => {
      const r = (await s.call("duo_review_changes", {})).structuredContent;
      return { status: r.status, verdict: r.verdict, claims: (r.claims ?? []).map((c: { id: string; alignment: string }) => `${c.id}:${c.alignment}`) };
    };
    const before = await review();
    expect(before.status).toBe("ready");

    // A: an old-style request still works.
    const a = await s.call("duo_propose_decision", { title: "Weekday rotation", question: "rotation_days", answer: "weekdays only", agent: "codex" });
    expect(a.isError).toBeFalsy();
    expect(a.structuredContent).toMatchObject({ format: "duo.proposal/1", proposalId: "P-001", confirmed: false });
    // B: forbids + enforcement block; only a proposal file appears.
    const b = await s.call("duo_propose_decision", {
      title: "No direct clock access", question: "clock_access", answer: "Scheduler code takes time from an injected clock",
      governs: { paths: ["src/**"] }, forbids: { symbols: ["*SystemClock*"], paths: ["src/legacy/**"] }, enforcement: "block", agent: "codex",
    });
    expect(b.isError).toBeFalsy();
    expect(b.structuredContent.proposalId).toBe("P-002");
    expect(decisionFiles()).toEqual([]);
    const pFile = fs.readFileSync(path.join(p.root, b.structuredContent.path), "utf8");
    expect(pFile).toContain("enforcement: block");
    expect(pFile).toContain("proposed_by_kind: agent");
    // J: proposals change no verdict. A proposal file makes the index stale (as in 0.2.1); after the human's index the result is the same.
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);
    expect(await review()).toEqual(before);

    // C/K: a supersede proposal leaves the target byte-identical.
    expect((await createDecisionService({ root: p.root }).confirm(human, "P-001")).value?.decisionId).toBe("D-001");
    const d001 = readD("D-001");
    const c = await s.call("duo_propose_decision", { title: "Every day rotation", question: "rotation_days", answer: "every day", supersedes: "D-001", agent: "codex" });
    expect(c.isError).toBeFalsy();
    expect(c.structuredContent.proposalId).toBe("P-003");
    expect(readD("D-001")).toBe(d001);
    expect(decisionFiles()).toEqual(["D-001.yaml"]);

    // D-H: invalid input or a missing target writes nothing.
    const listing = proposalFiles();
    const invalid: Record<string, unknown>[] = [
      { forbids: { paths: ["../outside/**"] } }, { forbids: {} }, { forbids: { paths: [] } }, { enforcement: "error" },
      { supersedes: "P-003" }, { supersedes: "AUTH-1" }, { supersedes: "D-099" }, { kind: "constraint" }, { evidence: [] },
      { forbids: { symbols: ["src/scheduler.ts#Scheduler"] } }, { forbids: { symbols: ["src/Scheduler"] } },
    ];
    for (const extra of invalid) {
      const r = await s.call("duo_propose_decision", { title: "x", question: "q_invalid", answer: "a", ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(proposalFiles()).toEqual(listing);
    expect(readD("D-001")).toBe(d001);
    // T35.2: the refusal tells the agent what to send instead.
    const ref = await s.call("duo_propose_decision", { title: "x", question: "q_ref", answer: "a", forbids: { symbols: ["src/scheduler.ts#Scheduler"] } });
    expect(JSON.stringify(ref.content)).toContain("qualified names only");
    expect(JSON.stringify(ref.content)).toContain("*LegacyDb*");
    expect(proposalFiles()).toEqual(listing);
    expect((await s.call("duo_propose_decision", { title: "No scheduler rewrite", question: "q_ok", answer: "a", forbids: { symbols: ["*Scheduler*"] }, enforcement: "warn" })).isError).toBeFalsy();
    const { tools: listed } = await s.client.listTools();
    expect(JSON.stringify(listed.find((t) => t.name === "duo_propose_decision")?.inputSchema)).toContain("qualified names of changed symbols");
    // T37 (H-72): imported_paths through the same tool; its exact semantics are in the agent-facing schema.
    const schemaText = JSON.stringify(listed.find((t) => t.name === "duo_propose_decision")?.inputSchema);
    expect(schemaText).toContain("Matches changed import/module-reference statements");
    expect(schemaText).toContain("It does not prove the import relation is newly introduced");
    const beforeBad = proposalFiles();
    expect((await s.call("duo_propose_decision", { title: "x", question: "q_bad_import", answer: "a", forbids: { imported_paths: ["../outside/**"] } })).isError).toBe(true);
    expect(proposalFiles()).toEqual(beforeBad);
    const imp = await s.call("duo_propose_decision", { title: "No legacy imports", question: "q_imports", answer: "a", forbids: { imported_paths: ["src/legacy/**"] }, enforcement: "block" });
    expect(imp.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(p.root, imp.structuredContent.path), "utf8")).toContain("imported_paths:");

    // I: once D-001 is superseded by a human confirm, a proposal to supersede it again writes nothing.
    expect((await createDecisionService({ root: p.root }).confirm(human, "P-003")).value).toMatchObject({ decisionId: "D-002", supersedes: "D-001" });
    const afterSupersede = proposalFiles();
    const again = await s.call("duo_propose_decision", { title: "Weekend rotation", question: "rotation_days", answer: "weekends", supersedes: "D-001" });
    expect(again.isError).toBe(true);
    expect(proposalFiles()).toEqual(afterSupersede);

    // L/M/N/O: nine tools, none confirms, rejects or writes a Decision; P-002 is still only a pending proposal.
    const { tools } = await s.client.listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((t) => t.name).filter((n) => /confirm|reject|write|delete|record|index/u.test(n))).toEqual([]);
    expect((await s.call("duo_get_status")).structuredContent.pendingDecisions.map((d: { id: string }) => d.id)).toEqual(["P-002", "P-004", "P-005"]);
    expect((await s.call("duo_get_decision", { id: "P-002" })).structuredContent.status).toBe("not-found");
  });
});

describe("H-73 provenance wording: an edited existing import line is not called new (T38, C240)", () => {
  it("F: machine provenance stays introduced; CLI and MCP text say not-in-adoption-baseline; verdict and payload unchanged", async () => {
    const p = existingProject(temps);
    p.write("src/db/legacy-db.ts", "export type LegacyRow = string;\n\nexport class LegacyDb {\n  run(sql: string): LegacyRow {\n    return sql;\n  }\n}\n");
    p.write("src/services/legacy-report.ts", "import { LegacyDb } from \"../db/legacy-db.js\";\n\nexport function legacyReport(): string {\n  return new LegacyDb().run(\"select 1\");\n}\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "legacy report");
    const init = duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }]));
    expect(init.code).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "duo init");
    const s = await open(p.root);
    const prop = await s.call("duo_propose_decision", { title: "No legacy-db imports", question: "q_legacy_db", answer: "Use DbClient", forbids: { imported_paths: ["src/db/legacy-db.ts"] }, enforcement: "block" });
    expect(prop.isError).toBeFalsy();
    expect((await createDecisionService({ root: p.root }).confirm({ kind: "human", name: "Ada Lovelace" }, String(prop.structuredContent.proposalId))).value?.decisionId).toEqual(expect.any(String));
    p.git("add", "-A");
    p.git("commit", "-qm", "confirm decision");
    // The import existed before adoption; this change only edits the binding list of that line.
    p.edit("src/services/legacy-report.ts", "import { LegacyDb } from", "import { LegacyDb, type LegacyRow } from");
    expect(duoctl(p.root, ["index"]).code).toBe(0);

    const json = duoctl(p.root, ["review", "--json"]).json().result;
    const claims = json.claims.filter((c: { rule: string }) => c.rule === "decision-forbids-import");
    expect(json.verdict).toBe("BLOCK");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ alignment: "CONFLICT", reason: "forbidden-import", provenance: "introduced", blockEligible: true });
    expect(claims[0].observed).toContain("forbidden import on a changed line");
    const mcp = await s.call("duo_review_changes", {});
    expect(mcp.structuredContent).toEqual(json);

    const human = duoctl(p.root, ["review"]).stdout;
    const line = human.split("\n").find((l) => l.includes("decision-forbids-import")) ?? "";
    expect(line).toContain("forbidden-import");
    expect(line).toContain("[blocking, not-in-adoption-baseline]");
    const ko = duoctl(p.root, ["review", "--locale", "ko"]).stdout;
    expect(ko).toContain("[blocking, 채택 기준선에 없음]");
    const summary = String(mcp.content[0]?.text);
    expect(summary).toContain("(not-in-adoption-baseline) [blocking; current authority]");
    for (const out of [human, ko, summary]) {
      expect(out).not.toMatch(/introduced/u);
      expect(out).not.toMatch(/new import|newly introduced import|introduced relation/iu);
    }
  });
});

