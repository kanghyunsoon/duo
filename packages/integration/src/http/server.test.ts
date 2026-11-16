/**
 * T18.1 local UI server: API contract and security, over a real server on a fixture repository.
 * Raw node:http is used so the tests can send any Host, Origin and headers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { recordReview, reviewChanges } from "@duo-director/director";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMProviderPool } from "../llm/factory.js";
import { CONTENT_SECURITY_POLICY, locateUiAssets, startDuoUiServer, type DuoUiServer } from "./server.js";
import { completeWorkTask, listWorkTasks, touchWorkTask } from "./work-map.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const FIXTURE = fileURLToPath(new URL("../../../../fixtures/review/app/", import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const temps: string[] = [];
let registry: AnalyzerRegistry;
let root: string;
let server: DuoUiServer;
let cookie = "";
let csrf = "";

interface Res { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string; json(): { format: string; ok: boolean; data: Record<string, unknown> & { [k: string]: unknown }; error?: { code: string } } }
function request(method: string, target: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: target, headers: { Host: `127.0.0.1:${server.port}`, ...options.headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
const get = (p: string, headers: Record<string, string> = {}) => request("GET", p, { headers: { Cookie: cookie, ...headers } });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) => request("POST", p, {
  headers: { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json", "X-Duo-CSRF": csrf, ...headers }, body: JSON.stringify(body),
});
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env, windowsHide: true, stdio: "pipe" });
async function index() {
  const store = openProjectGraphStore(root).value;
  if (store === undefined) throw new Error("graph");
  try { await indexRepository(root, { store, registry }); } finally { store.close(); }
}
const edit = (f: string, from: string, to: string) => { const p = path.join(root, f); fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(from, to)); };

beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error("registry");
  registry = created.value;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-ui-")));
  temps.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-qm", "init");
  await index();
  if (locateUiAssets() === undefined) throw new Error("build the UI first (pnpm build)");
  server = await startDuoUiServer({ root, version: "test", registry, llm: new LLMProviderPool({}) });
  const launch = await request("GET", new URL(server.launchUrl).pathname + new URL(server.launchUrl).search);
  cookie = String(launch.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  csrf = String((await get("/api/session")).json().data.csrf);
});
afterAll(async () => {
  await server?.close();
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("work map projection", () => {
  it("keys active MCP work by normalized full text, retains IDs on repeat, and starts a new ID after completion", () => {
    const session = "identity-policy-session";
    const first = touchWorkTask(root, "Codex", "  Inspect launch\r\npath  ", new Date("2026-10-21T00:00:00Z"), { duoSessionId: session });
    const repeated = touchWorkTask(root, "Codex", "Inspect launch\npath", new Date("2026-10-21T00:00:01Z"),
      { duoSessionId: session, targetRef: "issue:AUTH-7" });
    const resolvedAgain = touchWorkTask(root, "Codex", "Inspect launch\npath", new Date("2026-10-21T00:00:01Z"), { duoSessionId: session });
    const similar = touchWorkTask(root, "Codex", "Inspect launch\nroute", new Date("2026-10-21T00:00:02Z"), { duoSessionId: session });
    expect(first?.id).toBe(repeated?.id);
    expect(first?.id).toBe(resolvedAgain?.id);
    expect(first?.taskKey).toBe(repeated?.taskKey);
    expect(repeated?.targetRef).toBe("issue:AUTH-7");
    expect(similar?.id).not.toBe(first?.id);
    expect(similar?.name).toBe(first?.name);

    const completed = completeWorkTask(root, first?.id ?? "", new Date("2026-10-21T00:00:03Z"));
    const restarted = touchWorkTask(root, "Codex", "Inspect launch\npath", new Date("2026-10-21T00:00:04Z"), { duoSessionId: session });
    expect(completed?.status).toBe("completed");
    expect(restarted?.id).not.toBe(first?.id);
    expect(listWorkTasks(root).filter((task) => task.taskKey === first?.taskKey).map((task) => task.status)).toEqual(["completed", "active"]);
    if (restarted !== undefined) completeWorkTask(root, restarted.id, new Date("2026-10-21T00:00:05Z"));
    if (similar !== undefined) completeWorkTask(root, similar.id, new Date("2026-10-21T00:00:05Z"));
  });

  it("bounds activity lock contention to the MCP-specific wait budget", () => {
    const runtime = path.join(root, ".duo-project", "runtime");
    const lock = path.join(runtime, "work-tasks.lock");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(lock, "held by another process", "utf8");
    const start = performance.now();
    try {
      expect(() => touchWorkTask(root, "Codex", "Lock wait probe", new Date(), { duoSessionId: "lock-probe" }, 100))
        .toThrow("Timed out waiting for work task lock");
      expect(performance.now() - start).toBeLessThan(1000);
    } finally { fs.rmSync(lock, { force: true }); }
  });

  it("migrates v1 tasks without changing their IDs", () => {
    const file = path.join(root, ".duo-project", "runtime", "work-tasks.json");
    const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    const legacy = [{ id: "legacy-task-id", agent: "Codex", name: "Legacy work", updatedAt: "2026-10-20T00:00:00Z", status: "active" }];
    try {
      fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
      expect(listWorkTasks(root)).toEqual([expect.objectContaining({ ...legacy[0], identitySource: "legacy" })]);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ format: "duo.work-tasks/2", tasks: [{ id: "legacy-task-id" }] });
    } finally {
      if (previous === undefined) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, previous, "utf8");
    }
  });

  it("detects missed task and repository edits through a small revision", async () => {
    const before = (await get("/api/work-revision")).json().data.revision;
    expect(typeof before).toBe("string");
    const created = await post("/api/work-tasks", { agent: "Codex", name: "Revision probe" });
    expect(created.status).toBe(200);
    const afterTask = (await get("/api/work-revision")).json().data.revision;
    expect(afterTask).not.toBe(before);
    const file = path.join(root, "revision-probe.txt");
    fs.writeFileSync(file, "one");
    const afterFile = (await get("/api/work-revision")).json().data.revision;
    expect(afterFile).not.toBe(afterTask);
    fs.writeFileSync(file, "longer content");
    expect((await get("/api/work-revision")).json().data.revision).not.toBe(afterFile);
    fs.rmSync(file);
    await post("/api/work-task-complete", { id: (created.json().data.task as { id: string }).id });
  });

  it("streams a repository change to the authenticated UI session", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, path: "/api/work-events", headers: {
        Host: `127.0.0.1:${server.port}`, Cookie: cookie,
      } }, (res) => {
        let received = "";
        res.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
          if (received.includes('"kind":"connected"')) fs.writeFileSync(path.join(root, "watch-probe.tmp"), "probe");
          if (received.includes('"kind":"repository-changed"')) {
            fs.rmSync(path.join(root, "watch-probe.tmp"), { force: true });
            req.destroy(); resolve();
          }
        });
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => { req.destroy(); reject(new Error("repository change event timed out")); }, 5000).unref();
    });
  });

  it("stores compact task and graph JSON while reusing DUO issue relations", async () => {
    const created = await post("/api/work-tasks", { agent: "Codex", name: "Refresh flow", issueId: "AUTH-7" });
    expect(created.status).toBe(200);
    const task = created.json().data.task as { id: string };
    const response = await get(`/api/work-map?selected=${task.id}`);
    expect(response.status).toBe(200);
    const map = response.json().data as { nodes: { id: string; label: string }[]; edges: { source: string; type: string }[]; selectedTaskId: string };
    expect(map.selectedTaskId).toBe(task.id);
    expect(map.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: `task:${task.id}`, label: "[Codex] Refresh flow" })]));
    expect(map.nodes.some((n) => n.id.includes("AUTH-7"))).toBe(true);
    expect(map.edges.some((e) => e.source === "duo")).toBe(true);
    const saved = fs.readFileSync(path.join(root, ".duo-project/cache/work-map.json"), "utf8");
    expect(saved).toBe(JSON.stringify(JSON.parse(saved)));
    expect(Buffer.byteLength(saved)).toBeLessThan(25_000);
    const expanded = await get("/api/work-expand?node=issue:AUTH-7&depth=1");
    expect(expanded.status).toBe(200);
    const expansion = expanded.json().data as { nodes: { type: string; label: string }[]; edges: { from: string; to: string }[] };
    expect(expansion.nodes.some((n) => n.type === "project" || n.label === "DUO")).toBe(false);
    expect(expansion.edges.every((edge) => !edge.from.startsWith("project:") && !edge.to.startsWith("project:"))).toBe(true);
    const deepExpansion = await get("/api/work-expand?node=issue:AUTH-7&depth=3");
    expect((deepExpansion.json().data as { nodes: unknown[] }).nodes.length).toBeLessThanOrEqual(24);
    expect((await post("/api/work-task-complete", { id: task.id })).status).toBe(200);
    const after = (await get("/api/work-map")).json().data as { nodes: { type: string }[] };
    expect(after.nodes.some((n) => n.type === "task")).toBe(false);
  });

  describe("#84: credentials never reach the task file, the map cache or the UI", () => {
    // Key-shaped canaries in the Context Packet redaction formats. Not real credentials.
    const KEY = "sk-proj-DUO84CANARY0123456789abcdef";
    const GH = "ghp_DUO84CANARY0123456789abcdefABCDEFGHIJ";
    const taskFile = () => path.join(root, ".duo-project", "runtime", "work-tasks.json");
    const mapCache = () => path.join(root, ".duo-project", "cache", "work-map.json");
    const stored = () => fs.readFileSync(taskFile(), "utf8");

    it("redacts an MCP task name and agent label but keeps the session task key of the full text", () => {
      const session = "redact-session-84";
      const text = `deploy with OPENAI_API_KEY=${KEY}\nsecond line`;
      const first = touchWorkTask(root, `Codex ${GH}`, text, new Date("2026-10-24T00:00:00Z"), { duoSessionId: session });
      expect(first?.name).toBe("deploy with OPENAI_API_KEY=[REDACTED]");
      expect(first?.agent).toBe("Codex [REDACTED]");
      expect(first?.taskKey).toBe(createHash("sha256").update(`${session}\0${text}`).digest("hex"));
      const again = touchWorkTask(root, `Codex ${GH}`, text, new Date("2026-10-24T00:00:01Z"), { duoSessionId: session });
      expect(again?.id).toBe(first?.id);
      const otherKey = touchWorkTask(root, `Codex ${GH}`, `deploy with OPENAI_API_KEY=${KEY}X\nsecond line`, new Date("2026-10-24T00:00:02Z"), { duoSessionId: session });
      expect(otherKey?.id).not.toBe(first?.id);
      expect(otherKey?.name).toBe(first?.name);
      expect(stored()).not.toContain("DUO84CANARY");
      for (const t of [first, otherKey]) if (t !== undefined) completeWorkTask(root, t.id, new Date("2026-10-24T00:00:03Z"));
      expect(stored()).not.toContain("DUO84CANARY");
    });

    it("redacts the whole first line before the 200-character cut", () => {
      const task = touchWorkTask(root, "Codex", `${"x".repeat(190)} ${KEY}`, new Date("2026-10-24T00:01:00Z"), { duoSessionId: "redact-cut-84" });
      expect(task?.name).toBe(`${"x".repeat(190)} [REDACTED]`.slice(0, 200));
      expect(task?.name).not.toContain("sk-proj");
      if (task !== undefined) completeWorkTask(root, task.id, new Date("2026-10-24T00:01:01Z"));
    });

    it("does not copy the credential into the lock-timeout error", () => {
      const lock = path.join(root, ".duo-project", "runtime", "work-tasks.lock");
      fs.writeFileSync(lock, "held", "utf8");
      try {
        let message = "";
        try { touchWorkTask(root, "Codex", `lock probe ${KEY}`, new Date(), { duoSessionId: "redact-lock-84" }, 50); }
        catch (error) { message = `${String(error)} ${String((error as Error).cause ?? "")}`; }
        expect(message).toMatch(/Timed out waiting for work task lock/u);
        expect(message).not.toContain("DUO84CANARY");
      } finally { fs.rmSync(lock, { force: true }); }
    });

    it("rewrites a task file written before #84 with redacted labels and the same IDs, keys and status", async () => {
      const previous = fs.existsSync(taskFile()) ? fs.readFileSync(taskFile(), "utf8") : undefined;
      const old = { format: "duo.work-tasks/2", tasks: [
        { id: "pre-84-active", agent: `Codex ${GH}`, name: `rotate ${KEY} today`, identitySource: "duo", duoSessionId: "pre-84", taskKey: "k".repeat(64),
          startedAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-24T09:00:00Z", status: "active" },
        { id: "pre-84-disconnected", agent: "Codex", name: `old ${KEY}`, identitySource: "duo", duoSessionId: "pre-84b",
          updatedAt: "2026-10-23T09:00:00Z", status: "disconnected" },
      ] };
      try {
        fs.writeFileSync(taskFile(), JSON.stringify(old), "utf8");
        const tasks = listWorkTasks(root);
        expect(tasks.map((t) => [t.id, t.name, t.agent, t.status, t.taskKey])).toEqual([
          ["pre-84-active", "rotate [REDACTED] today", "Codex [REDACTED]", "active", "k".repeat(64)],
          ["pre-84-disconnected", "old [REDACTED]", "Codex", "disconnected", undefined],
        ]);
        expect(stored()).not.toContain("DUO84CANARY");
        expect(JSON.parse(stored())).toMatchObject({ format: "duo.work-tasks/2", tasks: [{ id: "pre-84-active", taskKey: "k".repeat(64) }, { id: "pre-84-disconnected" }] });
        const response = await get("/api/work-map");
        expect(response.status).toBe(200);
        expect(response.body).not.toContain("DUO84CANARY");
        expect((response.json().data as { nodes: { id: string; label: string }[] }).nodes).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "task:pre-84-active", label: "[Codex [REDACTED]] rotate [REDACTED] today" })]));
        expect(fs.readFileSync(mapCache(), "utf8")).not.toContain("DUO84CANARY");
      } finally {
        if (previous === undefined) fs.rmSync(taskFile(), { force: true }); else fs.writeFileSync(taskFile(), previous, "utf8");
      }
    });

    it("redacts a manual UI task in the response, the task file and the map", async () => {
      const created = await post("/api/work-tasks", { agent: "Codex", name: `check ${KEY}` });
      expect(created.status).toBe(200);
      expect(created.body).not.toContain("DUO84CANARY");
      const task = created.json().data.task as { id: string; name: string };
      expect(task.name).toBe("check [REDACTED]");
      expect(stored()).not.toContain("DUO84CANARY");
      const map = await get(`/api/work-map?selected=${task.id}`);
      expect(map.body).not.toContain("DUO84CANARY");
      expect(fs.readFileSync(mapCache(), "utf8")).not.toContain("DUO84CANARY");
      expect((await post("/api/work-task-complete", { id: task.id })).status).toBe(200);
      expect(stored()).not.toContain("DUO84CANARY");
    });
  });

  it("focuses the most recently updated active work when none is selected", async () => {
    const first = (await post("/api/work-tasks", { agent: "Codex", name: "First work" })).json().data.task as { id: string };
    const second = (await post("/api/work-tasks", { agent: "Codex", name: "Latest work" })).json().data.task as { id: string };
    const map = (await get("/api/work-map")).json().data as { selectedTaskId: string };
    expect(map.selectedTaskId).toBe(second.id);
    await post("/api/work-task-complete", { id: first.id });
    await post("/api/work-task-complete", { id: second.id });
  });
});

describe("session and transport security (T18.1)", () => {
  it("the launch URL sets an HttpOnly SameSite=Strict session cookie and redirects without the token", async () => {
    const launch = await request("GET", new URL(server.launchUrl).pathname + new URL(server.launchUrl).search);
    expect(launch.status).toBe(303);
    expect(launch.headers.location).toBe("/overview");
    expect(String(launch.headers["set-cookie"])).toMatch(/^duo_ui_\d+=[\w-]+; HttpOnly; SameSite=Strict; Path=\/$/u);
    expect((await request("GET", "/?session=wrong")).status).toBe(403);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it("rejects a foreign Host (DNS rebinding), a missing session, a foreign Origin, a missing CSRF token, a form content type and GET on mutations", async () => {
    expect((await request("GET", "/overview", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await get("/api/overview", { Host: `192.168.0.10:${server.port}` })).json().error?.code).toBe("UI_HOST_REJECTED");
    expect((await request("GET", "/api/overview")).json().error?.code).toBe("UI_SESSION_REQUIRED");
    expect((await request("GET", "/api/overview", { headers: { Cookie: "duo_ui_1=forged" } })).status).toBe(401);
    expect((await post("/api/proposals/P-1/reject", {}, { Origin: "http://evil.example" })).json().error?.code).toBe("UI_ORIGIN_REJECTED");
    const noOrigin = await request("POST", "/api/proposals/P-1/reject", { headers: { Cookie: cookie, "Content-Type": "application/json", "X-Duo-CSRF": csrf }, body: "{}" });
    expect(noOrigin.json().error?.code).toBe("UI_ORIGIN_REJECTED");
    expect((await post("/api/proposals/P-1/reject", {}, { "X-Duo-CSRF": "" })).json().error?.code).toBe("UI_CSRF_REJECTED");
    expect((await post("/api/proposals/P-1/reject", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await get("/api/proposals/P-1/confirm")).status).toBe(405);
    expect((await get("/api/proposals/P-1/reject")).status).toBe(405);
  });

  it("serves only allowlisted assets and pages; path traversal gets 404; CSP and no CORS on every response", async () => {
    for (const p of ["/assets/../package.json", "/assets/%2e%2e%2fpackage.json", "/assets/..%5c..%5cpackage.json", "/../../etc/passwd", "/assets/index.html", "/assets/app.js.map", "/%2e%2e/.duo-project/project.yaml"]) {
      expect((await get(p)).status, p).toBe(404);
    }
    const page = await get("/entity/RPT-01");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    const js = await get("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/text\/javascript/u);
    for (const r of [page, js, await get("/api/overview")]) {
      expect(r.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  });

  it("malformed input is 400; Domain states are 200 (not-found, index-required, BLOCK are data)", async () => {
    expect((await post("/api/context", { task: "" })).status).toBe(400);
    expect((await post("/api/context", { task: "x", extra: 1 })).status).toBe(400);
    expect((await post("/api/review", { from: "--output=/tmp/x" })).status).toBe(400);
    expect((await get("/api/graph?node=")).status).toBe(400);
    expect((await get("/api/nope")).status).toBe(404);
    const missing = await get("/api/entity/NOPE-99");
    expect(missing.status).toBe(200);
    expect(missing.json().data.status).toBe("not-found");
  });
});

describe("read models and operations (T18.1)", () => {
  it("overview: status payload, counts, pending decisions, LLM disabled as plain state; no metrics for reads", async () => {
    const o = await get("/api/overview");
    expect(o.json()).toMatchObject({ format: "duo.ui.overview/1", ok: true, meta: { durationMs: expect.any(Number) } });
    const d = o.json().data as { status: { project: { name: string }; index: { status: string }; llm: string }; requirements: { total: number }; decisions: { active: number } };
    expect(d.status.project.name).toBe("review-app");
    expect(d.status.index.status).toBe("current");
    expect(d.status.llm).toBe("disabled");
    expect(d.requirements.total).toBeGreaterThan(0);
    await get("/api/direction");
    expect(fs.existsSync(path.join(root, ".duo-project", "runtime", "metrics.jsonl"))).toBe(false);
  });

  it("direction: Truth with state labels and sources; proposals kept apart from Decisions", async () => {
    const d = (await get("/api/direction")).json().data as { requirements: { id: string; location: { path: string } }[]; decisions: { id: string; label: string }[]; proposals: unknown[] };
    expect(d.requirements.find((r) => r.id === "RPT-01")?.location.path).toBe(".duo-project/specs/report.md");
    expect(d.decisions.find((x) => x.id === "D-010")?.label).toBe("CONFIRMED");
    expect(Array.isArray(d.proposals)).toBe(true);
  });

  it("entity, graph (bounded), search and evidence source slices through the shared operations", async () => {
    const e = (await get("/api/entity/RPT-01")).json().data as { status: string; type: string; text: string; trace: { nodes: unknown[] } };
    expect(e).toMatchObject({ status: "found", type: "requirement" });
    expect(e.text).toContain("## RPT-01 Usage report");
    expect(e.trace.nodes.length).toBeGreaterThan(0);
    const file = (await get(`/api/entity/${encodeURIComponent("src/report/build-report.ts")}`)).json().data;
    expect(file).toMatchObject({ status: "found", type: "node" });
    const g = (await get("/api/graph?node=RPT-01&kind=impact&depth=2")).json();
    expect(g).toMatchObject({ format: "duo.ui.graph/1", data: { status: "found", truncated: expect.any(Boolean) } });
    expect((await get("/api/graph?node=RPT-01&depth=9")).status).toBe(400);
    expect((await get("/api/search?q=RPT-01")).json().data.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: "RPT-01" })]));
    const slice = (await get("/api/source?path=src/report/build-report.ts&start=1&end=500")).json().data as { lines: string[]; end: number; truncated: boolean };
    expect(slice.lines.length).toBeLessThanOrEqual(120);
    fs.writeFileSync(path.join(root, "notes.txt"), "not indexed\n");
    expect((await get("/api/source?path=notes.txt&start=1&end=1")).status).toBe(404);
    expect((await get("/api/source?path=.env&start=1&end=1")).status).toBe(403);
    expect((await get("/api/source?path=../outside.txt&start=1&end=1")).status).toBe(400);
    fs.rmSync(path.join(root, "notes.txt"));
  });

  it("context and review run through the shared operations and meter as surface ui; llmCalls 0", async () => {
    const c = (await post("/api/context", { task: "RPT-01" })).json();
    expect(c).toMatchObject({ format: "duo.ui.context/1", data: { status: "ready", context: { packet: { metrics: { llmCalls: 0 } } } } });
    const r = (await post("/api/review", {})).json();
    expect(r).toMatchObject({ format: "duo.ui.review/1", data: { status: "ready", verdict: expect.stringMatching(/^(PASS|WARN|ASK|BLOCK)$/u), metrics: { llmCalls: 0 } } });
    const metrics = fs.readFileSync(path.join(root, ".duo-project", "runtime", "metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { surface: string; command: string });
    expect(metrics.map((m) => `${m.surface}:${m.command}`)).toEqual(["ui:context", "ui:review"]);
    expect(JSON.stringify(metrics)).not.toContain("RPT-01");
  });

  it("stale index: overview stale, context and review index-required; after an external index the same server is current (no restart)", async () => {
    edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
    const stale = (await get("/api/overview")).json().data as { status: { index: { status: string } } };
    expect(stale.status.index.status).toBe("stale");
    expect((await post("/api/context", { task: "RPT-01" })).json().data.status).toBe("index-required");
    expect((await post("/api/review", {})).json().data.status).toBe("index-required");
    await index();
    expect(((await get("/api/overview")).json().data as { status: { index: { status: string } } }).status.index.status).toBe("current");
    expect((await post("/api/context", { task: "RPT-01" })).json().data.status).toBe("ready");
    expect((await post("/api/review", { task: "RPT-01" })).json().data.status).toBe("ready");
  });

  it("review history: recorded reviews with the semantic supplement kept apart", async () => {
    const graph = openProjectGraphReader(root).value;
    if (graph === undefined) throw new Error("graph");
    try {
      const r = await reviewChanges(root, { task: "RPT-01", diff: { from: "HEAD", to: "WORKTREE" } }, { graph, registry });
      if (r.value === undefined) throw new Error("review");
      await recordReview(r.value.result, { root, actor: { kind: "human", name: "Ada" }, clock: () => new Date("2026-09-28T00:00:00Z") });
    } finally {
      graph.close();
    }
    const list = (await get("/api/reviews")).json().data as { records: { id: string; body: { review: { verdict: string } } }[] };
    expect(list.records).toHaveLength(1);
    const id = list.records[0]?.id ?? "";
    expect((await get(`/api/reviews/${id}`)).json().data).toMatchObject({ status: "found", record: { id } });
    expect((await get("/api/overview")).json().data).toMatchObject({ latestReview: { id } });
  });
});

describe("human decisions through DecisionService (T18.1)", () => {
  it("confirm needs the ID typed again; two tabs: the second confirm reads the committed state; reject leaves pending", async () => {
    const service = createDecisionService({ root });
    const agent = { kind: "agent" as const, name: "codex" };
    const a = await service.propose(agent, { title: "Round reports half up", question: "report_rounding", answer: "round half up", governs: { requirements: ["RPT-01"] } });
    const b = await service.propose(agent, { title: "Reports in cents", question: "report_unit", answer: "whole cents" });
    const pa = a.value?.proposalId ?? "";
    const pb = b.value?.proposalId ?? "";
    const proposals = (await get("/api/proposals")).json().data as { proposals: { id: string; status: string }[]; previews: Record<string, { nextDecisionId: string; digest: string }> };
    const digest = proposals.previews[pa]?.digest ?? "";
    expect(proposals.proposals.filter((p) => p.status === "pending").map((p) => p.id).sort()).toEqual([pa, pb].sort());
    expect(proposals.previews[pa]?.nextDecisionId).toMatch(/^D-\d+$/u);
    expect((await post(`/api/proposals/${pa}/confirm`, { confirmId: "P-wrong", previewDigest: digest })).json().error?.code).toBe("UI_CONFIRM_ID_MISMATCH");
    const confirmed = (await post(`/api/proposals/${pa}/confirm`, { confirmId: pa, previewDigest: digest })).json().data as { status: string; result: { decisionId: string; path: string } };
    expect(confirmed.status).toBe("confirmed");
    const second = (await post(`/api/proposals/${pa}/confirm`, { confirmId: pa, previewDigest: digest })).json();
    expect(second.ok).toBe(true); // a Domain answer, not an HTTP error
    expect(second.data).toMatchObject({ status: "failed", diagnostics: [expect.objectContaining({ code: "PROPOSAL_NOT_PENDING" })] });
    expect((await post(`/api/proposals/${pb}/reject`, { reason: "not now" })).json().data).toMatchObject({ status: "rejected" });
    const after = (await get("/api/proposals")).json().data as { proposals: { id: string; status: string; decisionId?: string }[] };
    expect(after.proposals.find((p) => p.id === pb)?.status).toBe("rejected");
    expect(after.proposals.filter((p) => p.status === "pending")).toEqual([]);
    const direction = (await get("/api/direction")).json().data as { decisions: { id: string; label: string }[] };
    expect(direction.decisions.find((d) => d.id === confirmed.result.decisionId)?.label).toBe("CONFIRMED");
    const written = fs.readFileSync(path.join(root, confirmed.result.path), "utf8");
    expect(written).toMatch(/confirmed_by: ui:/u);
    const metrics = fs.readFileSync(path.join(root, ".duo-project", "runtime", "metrics.jsonl"), "utf8");
    expect(metrics).toContain('"surface":"ui","command":"decision"');
  });
  it("informed confirm (T34.2): the preview carries the full candidate and a digest; a confirm bound to an outdated preview writes nothing", async () => {
    const service = createDecisionService({ root });
    const human = { kind: "human" as const, name: "Dev" };
    const id = (await service.propose(human, { title: "No float money", question: "money_type", answer: "integers only", forbids: { symbols: ["*FloatAmount*"] }, enforcement: "block" })).value?.proposalId ?? "";
    type P = { candidate: Record<string, unknown>; digest: string; expectedDecisionId: string; action: string };
    const before = ((await get("/api/proposals")).json().data as { previews: Record<string, P> }).previews[id];
    expect(before).toMatchObject({ action: "create", candidate: { forbids: { symbols: ["*FloatAmount*"] }, enforcement: "block", answer: "integers only" } });
    expect(before?.digest).toMatch(/^sha256:/u);
    edit(`.duo-project/decisions/proposals/${id}.yaml`, "enforcement: block", "enforcement: warn");
    const stale = (await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: before?.digest })).json();
    expect(stale.data).toMatchObject({ status: "failed", diagnostics: [expect.objectContaining({ code: "DECISION_CONFIRM_PREVIEW_CHANGED" })] });
    const after = ((await get("/api/proposals")).json().data as { previews: Record<string, P> }).previews[id];
    expect(after?.candidate.enforcement).toBe("warn");
    const ok = (await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: after?.digest })).json().data as { status: string; result: { decisionId: string } };
    expect(ok.status).toBe("confirmed");
    expect((await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: "x".repeat(101) })).status).toBe(400);
  });

  it("T34.3 a UI confirm must carry the preview digest: missing → 400 and nothing written; wrong or outdated → nothing written; current → confirmed", async () => {
    const service = createDecisionService({ root });
    const id = (await service.propose({ kind: "human", name: "Dev" }, { title: "Reports in UTC", question: "report_timezone", answer: "UTC" })).value?.proposalId ?? "";
    const decisionsDir = path.join(root, ".duo-project", "decisions");
    const files = () => fs.readdirSync(decisionsDir).filter((f) => f.endsWith(".yaml")).sort();
    const proposalFile = path.join(decisionsDir, "proposals", `${id}.yaml`);
    const preview = () => ((get("/api/proposals")).then((r) => (r.json().data as { previews: Record<string, { digest: string; sourceKind: string }> }).previews[id]));
    const before = files();
    const missing = await post(`/api/proposals/${id}/confirm`, { confirmId: id });
    expect(missing.status).toBe(400);
    expect(missing.json().error?.code).toBe("UI_REQUEST_INVALID");
    expect((await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: "" })).status).toBe(400);
    const wrong = (await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: `sha256:${"0".repeat(64)}` })).json();
    expect(wrong.data).toMatchObject({ status: "failed", diagnostics: [expect.objectContaining({ code: "DECISION_CONFIRM_PREVIEW_CHANGED" })] });
    const old = await preview();
    expect(old?.sourceKind).toBe("proposal");
    fs.writeFileSync(proposalFile, fs.readFileSync(proposalFile, "utf8").replace("answer: UTC", "answer: local time"));
    const outdated = (await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: old?.digest })).json();
    expect(outdated.data).toMatchObject({ status: "failed", diagnostics: [expect.objectContaining({ code: "DECISION_CONFIRM_PREVIEW_CHANGED" })] });
    expect(files()).toEqual(before);
    expect(fs.existsSync(proposalFile)).toBe(true);
    const current = await preview();
    const ok = (await post(`/api/proposals/${id}/confirm`, { confirmId: id, previewDigest: current?.digest })).json().data as { status: string; result: { decisionId: string; path: string } };
    expect(ok.status).toBe("confirmed");
    expect(fs.readFileSync(path.join(root, ok.result.path), "utf8")).toContain("answer: local time");
  });
});

