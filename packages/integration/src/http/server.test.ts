/**
 * T18.1 local UI server: API contract and security, over a real server on a fixture repository.
 * Raw node:http is used so the tests can send any Host, Origin and headers.
 */
import { execFileSync } from "node:child_process";
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
    const proposals = (await get("/api/proposals")).json().data as { proposals: { id: string; status: string }[]; previews: Record<string, { nextDecisionId: string }> };
    expect(proposals.proposals.filter((p) => p.status === "pending").map((p) => p.id).sort()).toEqual([pa, pb].sort());
    expect(proposals.previews[pa]?.nextDecisionId).toMatch(/^D-\d+$/u);
    expect((await post(`/api/proposals/${pa}/confirm`, { confirmId: "P-wrong" })).json().error?.code).toBe("UI_CONFIRM_ID_MISMATCH");
    const confirmed = (await post(`/api/proposals/${pa}/confirm`, { confirmId: pa })).json().data as { status: string; result: { decisionId: string; path: string } };
    expect(confirmed.status).toBe("confirmed");
    const second = (await post(`/api/proposals/${pa}/confirm`, { confirmId: pa })).json();
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
});
