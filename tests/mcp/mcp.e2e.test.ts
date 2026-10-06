import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
      expect(t.annotations?.readOnlyHint).toBe(t.name !== "duo_propose_decision");
    }
    const describe = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
    expect(describe("duo_get_context")).toMatch(/Does not modify or index the repository.*index-required/su);
    expect(describe("duo_review_changes")).toContain("Does not modify code or project truth");
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
    const missing = await s.call("duo_trace", { node: "NoSuchThing" });
    expect(missing.isError).toBeFalsy();
    expect(missing.structuredContent).toMatchObject({ format: "duo.trace/1", status: "not-found" });
  });

  it("the same MCP process sees a stale index, returns index-required without indexing, and sees the CLI index", async () => {
    p.edit("src/scheduler.ts", "% 7", "% 5");
    const before = snapshot(p.root);
    expect((await s.call("duo_get_status")).structuredContent.index).toMatchObject({ status: "stale", changes: { files: 1 } });
    const ctx = await s.call("duo_get_context", { task: "Scheduler.next" });
    expect(ctx.isError).toBeFalsy();
    expect(ctx.structuredContent.status).toBe("index-required");
    expect(ctx.content[0]?.text).toContain("duoctl index");
    const rv = await s.call("duo_review_changes", {});
    expect(rv.isError).toBeFalsy();
    expect(rv.structuredContent.status).toBe("index-required");
    // Nothing indexed by the reads (metrics.jsonl is the only file the metered tools append to).
    expect(snapshot(p.root).filter(([f]) => !f.endsWith("metrics.jsonl"))).toEqual(before.filter(([f]) => !f.endsWith("metrics.jsonl")));
    // The CLI writes the graph while this MCP server is running.
    const idx = duoctl(p.root, ["index", "--json"]);
    expect(idx.code).toBe(0);
    expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
    expect((await s.call("duo_get_context", { task: "Scheduler.next" })).structuredContent.status).toBe("ready");
    const ready = (await s.call("duo_review_changes", {})).structuredContent;
    expect(ready).toMatchObject({ format: "duo.review/1", status: "ready", metrics: { llmCalls: 0 } });
    expect(ready.diff.files.map((f: { path: string }) => f.path)).toContain("src/scheduler.ts");
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

  it("propose is the only write: P-001 is a pending proposal, not a Decision, and nothing can confirm it", async () => {
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

  it("metrics: MCP calls append structured entries with surface mcp, no task or source text; read-only tools none", () => {
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

