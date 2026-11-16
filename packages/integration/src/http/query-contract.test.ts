/**
 * #77: the query contract of three GET routes over a real UI server. GET /api/decisions/{id} and
 * GET /api/proposals/{id}/preview take no query at all; GET /api/decisions refuses a repeated parameter name instead of
 * keeping the last value. Refusals are 400 UI_REQUEST_INVALID in the duo.ui.error/1 envelope, after the existing Host,
 * session, Origin/CSRF and method checks, and change nothing on disk. Other GET routes are deliberately unchanged.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LLMProviderPool } from "../llm/factory.js";
import { startDuoUiServer, type DuoUiServer } from "./server.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const env = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const temps: string[] = [];
let server: DuoUiServer;
let registry: AnalyzerRegistry;
let root = "";
let cookie = "";
let csrf = "";

interface Res { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string; json(): { format: string; ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } } }

function send(method: string, target: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const length: Record<string, string> = body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) };
    const req = http.request({ agent: false, host: "127.0.0.1", port: server.port, method, path: target, headers: { Host: "127.0.0.1:" + String(server.port), ...length, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (x: string) => { text += x; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const get = (target: string, headers: Record<string, string> = {}) => send("GET", target, { Cookie: cookie, ...headers });
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, env, windowsHide: true, stdio: "pipe" }).toString();

/** Every file under .duo-project/ except runtime/, plus the repository decision lock that mutations take. */
function snapshot(): string {
  const dir = path.join(root, ".duo-project");
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => !/^runtime([\\/]|$)/u.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
  const lock = path.join(dir, "runtime/locks/decisions.lock");
  return JSON.stringify({ files, lock: fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : null });
}

const PROBE = "probe-value-77";

function expectRefused(r: Res, status: number, code: string, message?: string) {
  expect(r.status, r.body).toBe(status);
  expect(r.json()).toMatchObject({ format: "duo.ui.error/1", ok: false, error: { code, ...(message === undefined ? {} : { message }) } });
  expect(r.json()).not.toHaveProperty("data");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  const secret = cookie.split("=")[1] ?? "";
  for (const s of [PROBE, root, root.replaceAll("\\", "/"), csrf, ...(secret === "" ? [] : [secret])]) expect(r.body).not.toContain(s);
  expect(r.body).not.toMatch(/\n\s+at /u);
}

beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error("registry");
  registry = created.value;
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "duo-q77-assets-"));
  temps.push(assets);
  fs.writeFileSync(path.join(assets, "index.html"), "<!doctype html><div id=\"root\"></div>");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-q77-")));
  temps.push(root);
  fs.mkdirSync(path.join(root, ".duo-project"), { recursive: true });
  fs.writeFileSync(path.join(root, ".duo-project/project.yaml"), "schema_version: 1\nname: q77\n");
  const service = createDecisionService({ root });
  const human = { kind: "human" as const, name: "Ada" };
  const agent = { kind: "agent" as const, name: "codex" };
  const p1 = await service.propose(agent, { title: "Use Postgres", question: "database", answer: "postgres" });
  if (p1.value === undefined || (await service.confirm(human, p1.value.proposalId)).value === undefined) throw new Error("setup D-001");
  if ((await service.propose(agent, { title: "Use SQLite", question: "database", answer: "sqlite", supersedes: "D-001" })).value === undefined) throw new Error("setup P-002");
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-qm", "state");
  server = await startDuoUiServer({ root, version: "test", registry, llm: new LLMProviderPool({}), assetsDir: assets });
  const launch = new URL(server.launchUrl);
  const opened = await send("GET", launch.pathname + launch.search);
  cookie = String(opened.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  csrf = String((await get("/api/session")).json().data.csrf);
});

afterAll(async () => {
  await server?.close();
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const NO_QUERY_ROUTES = ["/api/decisions/D-001", "/api/proposals/P-002/preview"] as const;
const ANY_QUERY = ["?x=1", "?debug=" + PROBE, "?" + PROBE + "=1", "?state=confirmed", "?a", "?=", "?x=1&x=2", "?%00=1"];
const REPEATED = ["?state=confirmed&state=superseded", "?q=use&q=use", "?q=" + PROBE + "&state=confirmed&q=x"];
const ids = (r: Res) => ((r.json().data.decisions ?? []) as { id: string }[]).map((d) => d.id);

describe("query contract of the Decision and preview GET routes (#77)", () => {
  it.each(NO_QUERY_ROUTES.flatMap((route) => ANY_QUERY.map((q) => [route, q] as const)))("%s refuses the query %s and changes nothing", async (route, q) => {
    const before = snapshot();
    expectRefused(await get(route + q), 400, "UI_REQUEST_INVALID", "this route takes no query parameters");
    expect(snapshot()).toBe(before);
  });

  it("without a query, or with an empty '?', both routes answer as before", async () => {
    for (const route of NO_QUERY_ROUTES) {
      const plain = await get(route);
      expect(plain.status, plain.body).toBe(200);
      const empty = await get(route + "?");
      expect(empty.status).toBe(200);
      expect(empty.json().data).toEqual(plain.json().data);
    }
    expect((await get("/api/decisions/D-001")).json().data).toMatchObject({ status: "found", id: "D-001" });
    expect((await get("/api/proposals/P-002/preview")).json().data).toMatchObject({ status: "ready" });
  });

  it.each(REPEATED)("the Decision list refuses the repeated name in %s and changes nothing", async (q) => {
    const before = snapshot();
    expectRefused(await get("/api/decisions" + q), 400, "UI_REQUEST_INVALID", "a query parameter is repeated");
    expect(snapshot()).toBe(before);
  });

  it("the Decision list still accepts each parameter once, and still refuses unknown names", async () => {
    for (const [q, want] of [["", ["D-001"]], ["?state=confirmed", ["D-001"]], ["?state=superseded", []], ["?q=postgres", ["D-001"]], ["?q=use&state=confirmed", ["D-001"]], ["?state=confirmed&q=USE", ["D-001"]]] as const) {
      const r = await get("/api/decisions" + q);
      expect(r.status, q).toBe(200);
      expect(ids(r), q).toEqual(want);
    }
    expectRefused(await get("/api/decisions?sort=id"), 400, "UI_REQUEST_INVALID");
  });

  it("Host, session, Origin/CSRF and method are still checked first", async () => {
    const offending = [...NO_QUERY_ROUTES.map((r) => r + "?debug=" + PROBE), "/api/decisions?state=confirmed&state=" + PROBE];
    const json = { Cookie: cookie, "Content-Type": "application/json" };
    const before = snapshot();
    for (const target of offending) {
      expectRefused(await send("GET", target), 401, "UI_SESSION_REQUIRED");
      expectRefused(await send("GET", target, { Cookie: cookie.replace(/=.*/u, "=forged") }), 401, "UI_SESSION_REQUIRED");
      expectRefused(await get(target, { Host: "evil.example" }), 403, "UI_HOST_REJECTED");
      expectRefused(await get(target, { Host: "127.0.0.1:0" }), 403, "UI_HOST_REJECTED");
      expectRefused(await send("POST", target, json, "{}"), 403, "UI_ORIGIN_REJECTED");
      expectRefused(await send("POST", target, { ...json, Origin: server.origin }, "{}"), 403, "UI_CSRF_REJECTED");
      expectRefused(await send("POST", target, { ...json, Origin: server.origin, "X-Duo-CSRF": csrf }, "{}"), 405, "UI_METHOD_NOT_ALLOWED");
      // A GET is still not checked for Origin: the query is what refuses it.
      expectRefused(await get(target, { Origin: "https://evil.example" }), 400, "UI_REQUEST_INVALID");
    }
    expect(snapshot()).toBe(before);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("other GET routes keep their query handling (the change is limited to these three routes)", async () => {
    expect((await get("/api/proposals?x=1")).status).toBe(200);
    expect((await get("/api/entity/D-001?x=1")).status).toBe(200);
    expect((await get("/api/direction?x=1")).status).toBe(200);
  });
});

