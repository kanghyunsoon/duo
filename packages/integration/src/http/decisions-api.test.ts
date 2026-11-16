/**
 * BE-API-02 (T95): GET /api/decisions and GET /api/decisions/{id} over a real UI server. The Decisions are made
 * through DecisionService (propose → confirm → supersede) plus one hand-written manual Decision, and a second
 * repository holds damaged Truth. Every request is a GET; the tests check that nothing on disk changes.
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
const servers: DuoUiServer[] = [];
let registry: AnalyzerRegistry;
let assets: string;
const human = { kind: "human" as const, name: "Ada" };
const agent = { kind: "agent" as const, name: "codex" };

interface Client { readonly root: string; readonly server: DuoUiServer; readonly cookie: string; readonly csrf: string }
interface Res { readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: string; json(): { format: string; ok: boolean; data: Record<string, unknown>; error?: { code: string } } }

function send(c: Pick<Client, "server">, method: string, target: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    // agent: false, so a restart test on the same port never reuses a keep-alive socket of the previous server run.
    // Content-Length with a body: Node does not chunk a DELETE body, and without a length the server's parser would see a malformed request.
    const length: Record<string, string> = body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) };
    const req = http.request({ agent: false, host: "127.0.0.1", port: c.server.port, method, path: target, headers: { Host: "127.0.0.1:" + String(c.server.port), ...length, ...headers } }, (res) => {
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
const get = (c: Client, target: string) => send(c, "GET", target, { Cookie: c.cookie });

function repo(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-api02-")));
  temps.push(root);
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  return root;
}
const git = (root: string, ...a: string[]) => execFileSync("git", a, { cwd: root, env, windowsHide: true, stdio: "pipe" }).toString();
function commit(root: string) {
  if (!fs.existsSync(path.join(root, ".git"))) {
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    git(root, "config", "core.autocrlf", "false");
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "state");
}

async function serve(root: string, port?: number): Promise<Client> {
  const server = await startDuoUiServer({ root, version: "test", registry, llm: new LLMProviderPool({}), assetsDir: assets, ...(port === undefined ? {} : { port }) });
  servers.push(server);
  const launch = new URL(server.launchUrl);
  const opened = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ agent: false, host: "127.0.0.1", port: server.port, method: "GET", path: launch.pathname + launch.search, headers: { Host: "127.0.0.1:" + String(server.port) } }, resolve);
    req.on("error", reject);
    req.end();
  });
  opened.resume();
  const cookie = String(opened.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  const partial = { root, server, cookie, csrf: "" };
  const csrf = String((await get(partial, "/api/session")).json().data.csrf);
  return { ...partial, csrf };
}

/** Every file under .duo-project/ except runtime/ (metrics and locks), path → content. */
function snapshot(root: string): [string, string][] {
  const dir = path.join(root, ".duo-project");
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => !/^runtime([\\/]|$)/u.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
}

const PROJECT = { ".duo-project/project.yaml": "schema_version: 1\nname: api02\n" };
const MANUAL = ["id: D-003", "title: Manual decision", "state: confirmed", "question: manual", "answer: written by hand", ""].join("\n");

let good: Client;

beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error("registry");
  registry = created.value;
  assets = fs.mkdtempSync(path.join(os.tmpdir(), "duo-api02-assets-"));
  temps.push(assets);
  fs.writeFileSync(path.join(assets, "index.html"), "<!doctype html><div id=\"root\"></div>");

  const root = repo(PROJECT);
  const service = createDecisionService({ root });
  const p1 = await service.propose(agent, { title: "Use Postgres", question: "database", answer: "postgres" });
  if (p1.value === undefined) throw new Error(JSON.stringify(p1.diagnostics));
  if ((await service.confirm(human, p1.value.proposalId)).value === undefined) throw new Error("confirm D-001");
  const p2 = await service.propose(agent, { title: "Use SQLite", question: "database", answer: "sqlite", supersedes: "D-001" });
  if (p2.value === undefined) throw new Error(JSON.stringify(p2.diagnostics));
  const c2 = await service.confirm(human, p2.value.proposalId);
  if (c2.value === undefined) throw new Error(JSON.stringify(c2.diagnostics));
  fs.writeFileSync(path.join(root, ".duo-project/decisions/D-003.yaml"), MANUAL);
  commit(root);
  good = await serve(root);
});

afterAll(async () => {
  for (const s of servers) await s.close();
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

type Summary = Record<string, unknown> & { id: string };
const list = async (c: Client, query = "") => {
  const r = await get(c, "/api/decisions" + query);
  expect(r.status, r.body).toBe(200);
  return r.json();
};

describe("GET /api/decisions (BE-API-02)", () => {
  it("lists every Decision in ID order with authority, lock status, origin and supersession from the files", async () => {
    const r = await list(good);
    expect(r.format).toBe("duo.ui.decisions/1");
    const data = r.data as { decisions: Summary[]; actorLabelsAuthenticated: boolean; truth: { complete: boolean; problems: unknown[] } };
    expect(data.decisions.map((d) => d.id)).toEqual(["D-001", "D-002", "D-003"]);
    const [d1, d2, d3] = data.decisions;
    expect(d1).toMatchObject({ state: "superseded", authority: "SUPERSEDED", locked: true, lockStatus: "valid", origin: "lifecycle", supersedes: null, supersededBy: "D-002", integrity: "ok", proposalId: "P-001" });
    expect(d2).toMatchObject({ state: "confirmed", authority: "CONFIRMED", locked: true, lockStatus: "valid", origin: "lifecycle", supersedes: "D-001", supersededBy: null, proposalId: "P-002", confirmedBy: "Ada" });
    expect(d3).toMatchObject({ state: "confirmed", authority: "CONFIRMED", locked: false, lockStatus: "missing", origin: "manual", integrity: "ok" });
    expect(d3).not.toHaveProperty("proposalId");
    expect(d2?.location).toEqual(expect.objectContaining({ path: ".duo-project/decisions/D-002.yaml" }));
    expect(data.actorLabelsAuthenticated).toBe(false);
    expect(data.truth).toEqual({ complete: true, problems: [] });
  });

  it("filters by state and by a case-insensitive match on ID or title; unknown or invalid parameters are 400", async () => {
    expect(((await list(good, "?state=superseded")).data.decisions as Summary[]).map((d) => d.id)).toEqual(["D-001"]);
    expect(((await list(good, "?q=sqlite")).data.decisions as Summary[]).map((d) => d.id)).toEqual(["D-002"]);
    expect(((await list(good, "?q=d-00&state=confirmed")).data.decisions as Summary[]).map((d) => d.id)).toEqual(["D-002", "D-003"]);
    for (const q of ["?state=active", "?sort=id", "?q="]) {
      const r = await get(good, "/api/decisions" + q);
      expect(r.status, q).toBe(400);
      expect(r.json().error?.code).toBe("UI_REQUEST_INVALID");
    }
  });
});

describe("GET /api/decisions/{id} (BE-API-02)", () => {
  it("returns one Decision with its content, the lock verification and the supersession chain oldest first", async () => {
    for (const id of ["D-001", "D-002"]) {
      const r = await get(good, "/api/decisions/" + id);
      expect(r.status).toBe(200);
      expect(r.json().format).toBe("duo.ui.decision-detail/1");
      const data = r.json().data as { status: string; decision: Record<string, unknown> };
      expect(data.status).toBe("found");
      expect(data.decision.chain).toEqual([
        { id: "D-001", state: "superseded", authority: "SUPERSEDED" },
        { id: "D-002", state: "confirmed", authority: "CONFIRMED" },
      ]);
    }
    const d2 = (await get(good, "/api/decisions/D-002")).json().data.decision as Record<string, unknown>;
    expect(d2).toMatchObject({ question: "database", answer: "sqlite", rationale: null, lock: { id: "D-002", status: "valid" } });
    const lock = d2.lock as { expected: string; recorded: string };
    expect(lock.recorded).toBe(lock.expected);
    const d3 = (await get(good, "/api/decisions/D-003")).json().data.decision as Record<string, unknown>;
    expect(d3).toMatchObject({ origin: "manual", lock: { status: "missing" }, chain: [{ id: "D-003", state: "confirmed", authority: "CONFIRMED" }] });
  });

  it("an unknown ID is not-found; a malformed or badly encoded ID and other methods are refused", async () => {
    const missing = (await get(good, "/api/decisions/D-099")).json();
    expect(missing.data).toMatchObject({ status: "not-found", id: "D-099", truth: { complete: true } });
    for (const p of ["/api/decisions/D%20001", "/api/decisions/%E0%A4%A", "/api/decisions/..%2F..%2Fproject", "/api/decisions/-D-001"]) {
      const r = await get(good, p);
      expect(r.status, p).toBe(400);
      expect(r.json().error?.code).toBe("UI_REQUEST_INVALID");
    }
    expect((await get(good, "/api/decisions/D-001/history")).status).toBe(404);
    const post = await send(good, "POST", "/api/decisions/D-001", { Cookie: good.cookie, Origin: good.server.origin, "Content-Type": "application/json", "X-Duo-CSRF": good.csrf }, "{}");
    expect(post.json().error?.code).toBe("UI_METHOD_NOT_ALLOWED");
  });

  it("needs the UI session like every other API route", async () => {
    expect((await send(good, "GET", "/api/decisions")).json().error?.code).toBe("UI_SESSION_REQUIRED");
    expect((await send(good, "GET", "/api/decisions/D-001", { Cookie: "duo_ui_1=forged" })).status).toBe(401);
  });

  it("reads only: no Truth file, Git state or working tree changes, and no absolute path or session secret in the bodies", async () => {
    const before = snapshot(good.root);
    const bodies: string[] = [];
    for (const p of ["/api/decisions", "/api/decisions?state=confirmed", "/api/decisions/D-001", "/api/decisions/D-002", "/api/decisions/D-003", "/api/decisions/D-099"]) bodies.push((await get(good, p)).body);
    expect(snapshot(good.root)).toEqual(before);
    expect(git(good.root, "status", "--porcelain")).toBe("");
    const secret = good.cookie.split("=")[1] ?? "";
    for (const b of bodies) {
      expect(b).not.toContain(good.root);
      expect(b).not.toContain(good.root.replaceAll("\\", "/"));
      expect(b).not.toContain(good.csrf);
      if (secret !== "") expect(b).not.toContain(secret);
    }
  });

  it("the existing direction and proposals routes are unchanged", async () => {
    const direction = (await get(good, "/api/direction")).json();
    expect(direction.format).toBe("duo.ui.direction/1");
    const decisions = (direction.data as { decisions: Record<string, unknown>[] }).decisions;
    expect(Object.keys(decisions[0] ?? {}).sort()).toEqual(["answer", "enforcement", "governs", "id", "label", "location", "locked", "question", "state", "supersededBy", "supersedes", "title"]);
    expect((await get(good, "/api/proposals")).json().format).toBe("duo.ui.proposals/1");
  });
});

describe("damaged or missing Truth (BE-API-02)", () => {
  it("reports a lock mismatch and an unreadable Decision file instead of hiding them, and never shows the machine path", async () => {
    const root = repo(PROJECT);
    const service = createDecisionService({ root });
    const p = await service.propose(agent, { title: "Use Postgres", question: "database", answer: "postgres" });
    if (p.value === undefined || (await service.confirm(human, p.value.proposalId)).value === undefined) throw new Error("setup");
    const d1 = path.join(root, ".duo-project/decisions/D-001.yaml");
    fs.writeFileSync(d1, fs.readFileSync(d1, "utf8").replace("answer: postgres", "answer: mysql"));
    fs.writeFileSync(path.join(root, ".duo-project/decisions/D-002.yaml"), "id: D-002\ntitle: [unclosed\n");
    commit(root);
    const c = await serve(root);
    const before = snapshot(root);
    const r = await list(c);
    const data = r.data as { decisions: Summary[]; truth: { complete: boolean; problems: { code: string; path?: string; message: string }[] } };
    expect(data.truth.complete).toBe(false);
    const codes = data.truth.problems.map((x) => x.code);
    expect(codes).toContain("DECISION_INTEGRITY_INVALID");
    expect(codes).toContain("YAML_SYNTAX_ERROR");
    expect(data.truth.problems.find((x) => x.code === "YAML_SYNTAX_ERROR")?.path).toBe(".duo-project/decisions/D-002.yaml");
    expect(data.decisions.map((d) => d.id)).toEqual(["D-001"]);
    expect(data.decisions[0]).toMatchObject({ authority: "CONFIRMED", lockStatus: "mismatch", integrity: "invalid" });
    expect((data.decisions[0]?.problems as { code: string }[]).map((x) => x.code)).toContain("DECISION_INTEGRITY_INVALID");
    const detail = (await get(c, "/api/decisions/D-002")).json().data as { status: string; truth: { complete: boolean } };
    expect(detail).toMatchObject({ status: "not-found", truth: { complete: false } });
    for (const b of [JSON.stringify(r), JSON.stringify(detail)]) {
      expect(b).not.toContain(root);
      expect(b).not.toContain(root.replaceAll("\\", "/"));
    }
    expect(snapshot(root)).toEqual(before);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("proposed, rejected and Markdown Decisions, and chain markers for a missing link and a loop, come from the files as they are", async () => {
    const yaml = (id: string, extra: string[]) => [`id: ${id}`, `title: ${id} title`, "question: q", "answer: a", ...extra, ""].join("\n");
    const root = repo({
      ...PROJECT,
      ".duo-project/decisions/D-010.yaml": yaml("D-010", ["state: proposed"]),
      ".duo-project/decisions/D-011.yaml": yaml("D-011", ["state: rejected"]),
      ".duo-project/decisions/D-012.yaml": yaml("D-012", ["state: confirmed", "supersedes: D-099"]),
      ".duo-project/decisions/D-013.yaml": yaml("D-013", ["state: confirmed", "supersedes: D-014"]),
      ".duo-project/decisions/D-014.yaml": yaml("D-014", ["state: confirmed", "supersedes: D-013"]),
      ".duo-project/decisions/ADR-020.md": ["---", "id: ADR-020", "type: decision", "title: Use events", "state: confirmed", "question: messaging", "answer: events", "---", "", "# ADR-020 Use events", "", "Events between services.", ""].join("\n"),
    });
    commit(root);
    const c = await serve(root);
    const before = snapshot(root);
    const data = (await list(c)).data as { decisions: Summary[]; truth: { complete: boolean; problems: { code: string }[] } };
    const by = Object.fromEntries(data.decisions.map((d) => [d.id, d]));
    expect(by["D-010"]).toMatchObject({ state: "proposed", authority: "PROPOSED", locked: false, lockStatus: "not-confirmed", origin: null });
    expect(by["D-011"]).toMatchObject({ state: "rejected", authority: "REJECTED", lockStatus: "not-confirmed", origin: null });
    expect(by["ADR-020"]).toMatchObject({ state: "confirmed", authority: "CONFIRMED", origin: "manual", lockStatus: "missing", location: expect.objectContaining({ path: ".duo-project/decisions/ADR-020.md" }) });
    expect(((await get(c, "/api/decisions/ADR-020")).json().data as { status: string }).status).toBe("found");
    const chain = async (id: string) => ((await get(c, "/api/decisions/" + id)).json().data as { decision: { chain: unknown[] } }).decision.chain;
    expect(await chain("D-012")).toEqual([{ id: "D-099", missing: true }, { id: "D-012", state: "confirmed", authority: "CONFIRMED" }]);
    expect(await chain("D-013")).toEqual([{ id: "D-013", loop: true }, { id: "D-014", state: "confirmed", authority: "CONFIRMED" }, { id: "D-013", state: "confirmed", authority: "CONFIRMED" }]);
    // The supersede cycle is a Truth error: shown, not hidden, and Truth is reported incomplete.
    expect(data.truth.complete).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });


  it("a repository without DUO answers not-initialized", async () => {
    const root = repo({ "README.md": "# none\n" });
    commit(root);
    const c = await serve(root);
    expect((await list(c)).data).toMatchObject({ status: "not-initialized" });
    expect((await get(c, "/api/decisions/D-001")).json().data).toMatchObject({ status: "not-initialized" });
  });
});

type Problem = { code: string; path?: string; line?: number; message: string };
const yamlDecision = (id: string, extra: string[]) => [`id: ${id}`, `title: ${id} title`, "question: q", "answer: a", ...extra, ""].join("\n");

describe("per-Decision integrity follows the Decision's own source range (#53 review)", () => {
  it("a Markdown or YAML self-supersede is invalid on that Decision; a Requirement's error in the same Markdown file and other files' errors are not", async () => {
    const root = repo({
      ...PROJECT,
      // ADR-style Markdown Decision that supersedes itself: the diagnostic is reported inside its frontmatter.
      ".duo-project/decisions/ADR-030.md": ["---", "id: ADR-030", "type: decision", "title: Self", "state: confirmed", "question: q", "answer: a", "supersedes: ADR-030", "---", "", "# ADR-030 Self", ""].join("\n"),
      ".duo-project/decisions/D-031.yaml": yamlDecision("D-031", ["state: confirmed", "supersedes: D-031"]),
      // A valid ADR-style Decision whose file also holds a Requirement section with a broken reference.
      ".duo-project/specs/ADR-032.md": ["---", "id: ADR-032", "type: decision", "title: Logging", "state: confirmed", "question: logs", "answer: structured", "---", "",
        "# ADR-032 Logging", "", "## REQ-032 Structured logs", "", "```duo", "type: requirement", "depends_on: [REQ-999]", "```", "", "Logs are JSON.", ""].join("\n"),
      ".duo-project/decisions/D-033.yaml": yamlDecision("D-033", ["state: confirmed"]),
    });
    commit(root);
    const c = await serve(root);
    const data = (await list(c)).data as { decisions: (Summary & { integrity: string; problems: Problem[] })[]; truth: { complete: boolean; problems: Problem[] } };
    const by = Object.fromEntries(data.decisions.map((d) => [d.id, d]));
    const codes = (id: string) => (by[id]?.problems ?? []).map((x) => x.code);

    // 1. Markdown self-supersede (before: integrity "ok" with problems []).
    expect(by["ADR-030"]).toMatchObject({ integrity: "invalid" });
    expect(codes("ADR-030")).toContain("DECISION_SUPERSEDES_SELF");
    // 2. YAML self-supersede: unchanged behaviour.
    expect(by["D-031"]).toMatchObject({ integrity: "invalid" });
    expect(codes("D-031")).toContain("DECISION_SUPERSEDES_SELF");
    // 3./4. The Requirement's broken reference stays with the Requirement: the ADR around it and other Decisions stay ok.
    const broken = data.truth.problems.find((x) => x.code === "BROKEN_REFERENCE" && x.path === ".duo-project/specs/ADR-032.md");
    expect(broken, JSON.stringify(data.truth.problems)).toBeDefined();
    expect(by["ADR-032"]).toMatchObject({ integrity: "ok", problems: [] });
    expect(by["D-033"]).toMatchObject({ integrity: "ok", problems: [] });
    expect(codes("ADR-030")).not.toContain("BROKEN_REFERENCE");
    expect(codes("D-031").filter((x) => x === "DECISION_SUPERSEDES_SELF")).toHaveLength(1);

    // 5. Truth-wide errors and per-Decision integrity agree: every Decision problem is a Truth problem.
    expect(data.truth.complete).toBe(false);
    const key = (x: Problem) => [x.code, x.path ?? "", x.line ?? "", x.message].join("|");
    const truthKeys = new Set(data.truth.problems.map(key));
    for (const d of data.decisions) for (const x of d.problems) expect(truthKeys.has(key(x)), d.id + " " + key(x)).toBe(true);

    // The detail answers the same as the list.
    for (const id of ["ADR-030", "D-031", "ADR-032", "D-033"]) {
      const detail = (await get(c, "/api/decisions/" + id)).json().data as { decision: { integrity: string; problems: Problem[] } };
      expect({ integrity: detail.decision.integrity, problems: detail.decision.problems }, id).toEqual({ integrity: by[id]?.integrity, problems: by[id]?.problems });
    }
  });
});

describe("supersession chain limit is explicit (#53 review)", () => {
  /** A valid chain base+1 → … → base+n: each older Decision is superseded by the next one. */
  const chainFiles = (base: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => {
    const id = `D-${base + i + 1}`;
    const extra = [i === n - 1 ? "state: confirmed" : "state: superseded"];
    if (i > 0) extra.push(`supersedes: D-${base + i}`);
    if (i < n - 1) extra.push(`superseded_by: D-${base + i + 2}`);
    return [`.duo-project/decisions/${id}.yaml`, yamlDecision(id, extra)];
  }));
  type Detail = { chain: { id: string; missing?: true; loop?: true }[]; truncated: { older: boolean; newer: boolean } };
  let c: Client;
  const detail = async (id: string) => ((await get(c, "/api/decisions/" + id)).json().data as { decision: Detail }).decision;
  const ids = (d: Detail) => d.chain.map((x) => x.id);

  beforeAll(async () => {
    const root = repo({
      ...PROJECT, ...chainFiles(400, 64), ...chainFiles(500, 65), ...chainFiles(600, 66),
      ".duo-project/decisions/D-701.yaml": yamlDecision("D-701", ["state: confirmed", "supersedes: D-799"]),
      ".duo-project/decisions/D-711.yaml": yamlDecision("D-711", ["state: confirmed", "supersedes: D-712"]),
      ".duo-project/decisions/D-712.yaml": yamlDecision("D-712", ["state: confirmed", "supersedes: D-711"]),
    });
    commit(root);
    c = await serve(root);
  });

  it("a short chain is whole and not truncated", async () => {
    const d2 = (await get(good, "/api/decisions/D-002")).json().data.decision as Detail;
    expect(ids(d2)).toEqual(["D-001", "D-002"]);
    expect(d2.truncated).toEqual({ older: false, newer: false });
  });

  it("64 and 65 Decisions (63 and 64 links from an end) are returned whole: reaching the limit exactly is not truncation", async () => {
    for (const [first, last, n] of [["D-401", "D-464", 64], ["D-501", "D-565", 65]] as const) {
      for (const id of [first, last]) {
        const d = await detail(id);
        expect(d.chain, id).toHaveLength(n);
        expect([ids(d)[0], ids(d).at(-1)], id).toEqual([first, last]);
        expect(d.truncated, id).toEqual({ older: false, newer: false });
      }
    }
  });

  it("66 Decisions: from the newest end the oldest is omitted and older is true; from the oldest end newer is true; the middle is whole", async () => {
    const newest = await detail("D-666");
    expect(newest.chain).toHaveLength(65);
    expect(ids(newest)[0]).toBe("D-602");
    expect(ids(newest)).not.toContain("D-601");
    expect(newest.truncated).toEqual({ older: true, newer: false });
    // A client continues from the last returned ID in that direction.
    expect(ids(await detail("D-602"))[0]).toBe("D-601");

    const oldest = await detail("D-601");
    expect(oldest.chain).toHaveLength(65);
    expect(ids(oldest).at(-1)).toBe("D-665");
    expect(oldest.truncated).toEqual({ older: false, newer: true });

    const middle = await detail("D-633");
    expect(middle.chain).toHaveLength(66);
    expect([ids(middle)[0], ids(middle).at(-1)]).toEqual(["D-601", "D-666"]);
    expect(middle.truncated).toEqual({ older: false, newer: false });
  });

  it("missing and loop markers are unchanged and are not truncation", async () => {
    const missing = await detail("D-701");
    expect(missing.chain).toEqual([{ id: "D-799", missing: true }, { id: "D-701", state: "confirmed", authority: "CONFIRMED" }]);
    expect(missing.truncated).toEqual({ older: false, newer: false });
    const loop = await detail("D-711");
    expect(loop.chain).toEqual([{ id: "D-711", loop: true }, { id: "D-712", state: "confirmed", authority: "CONFIRMED" }, { id: "D-711", state: "confirmed", authority: "CONFIRMED" }]);
    expect(loop.truncated).toEqual({ older: false, newer: false });
  });
});

// BE-API-10 for the Decision read routes (#53), with the request boundaries of preview-api.test.ts. A GET needs the UI
// session cookie and an allowed Host; Origin and CSRF are checked only on other methods (the server's existing contract),
// and no CORS header is ever sent. Damaged Truth and Markdown/YAML diagnostics are covered by the tests above.
const DECISION_ROUTES = ["/api/decisions", "/api/decisions/D-002"] as const;

/** The repository write lock DecisionService takes for mutations; a read must never create or leave it. */
function lockState(root: string): string {
  const f = path.join(root, ".duo-project/runtime/locks/decisions.lock");
  return fs.existsSync(f) ? "present:" + fs.readFileSync(f, "utf8") : "absent";
}
function noSecrets(body: string, c: Client) {
  const secret = c.cookie.split("=")[1] ?? "";
  for (const s of [c.root, c.root.replaceAll("\\", "/"), c.csrf, ...(secret === "" ? [] : [secret])]) expect(body).not.toContain(s);
  expect(body).not.toMatch(/\n\s+at /u);
}
function expectRefused(r: Res, status: number, code: string, c: Client = good) {
  expect(r.status, r.body).toBe(status);
  expect(r.json()).toMatchObject({ format: "duo.ui.error/1", ok: false, error: { code } });
  expect(r.json()).not.toHaveProperty("data");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  noSecrets(r.body, c);
}
const forged = (c: Client) => c.cookie.replace(/=.*/u, "=forged");
const sessionScenarios = ["foreign host", "wrong port", "missing session", "forged session"] as const;
const originScenarios = ["absent", "foreign", "null"] as const;

describe("Decision read request security (BE-API-10)", () => {
  it.each(DECISION_ROUTES.flatMap((route) => sessionScenarios.map((s) => [route, s] as const)))("%s refuses %s and changes nothing", async (route, scenario) => {
    const before = snapshot(good.root);
    const lock = lockState(good.root);
    const headers: Record<string, string> = { Cookie: good.cookie };
    if (scenario === "foreign host") headers.Host = "evil.example";
    if (scenario === "wrong port") headers.Host = "127.0.0.1:0";
    if (scenario === "missing session") delete headers.Cookie;
    if (scenario === "forged session") headers.Cookie = forged(good);
    const host = scenario === "foreign host" || scenario === "wrong port";
    expectRefused(await send(good, "GET", route, headers), host ? 403 : 401, host ? "UI_HOST_REJECTED" : "UI_SESSION_REQUIRED");
    expect(snapshot(good.root)).toEqual(before);
    expect(lockState(good.root)).toBe(lock);
  });

  it.each(DECISION_ROUTES.flatMap((route) => originScenarios.map((o) => [route, o] as const)))("%s with Origin %s is served like any authenticated GET, without CSRF and without CORS", async (route, origin) => {
    const baseline = (await get(good, route)).json().data;
    const headers: Record<string, string> = { Cookie: good.cookie, Host: "localhost:" + String(good.server.port) };
    if (origin === "foreign") headers.Origin = "https://evil.example";
    if (origin === "null") headers.Origin = "null";
    const r = await send(good, "GET", route, headers);
    expect(r.status, r.body).toBe(200);
    expect(r.json().data).toEqual(baseline);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    noSecrets(r.body, good);
  });

  it.each(["PUT", "DELETE", "PATCH"])("%s on a Decision route is refused for a foreign Origin or a missing CSRF token, and is not allowed with both", async (method) => {
    const before = snapshot(good.root);
    for (const route of DECISION_ROUTES) {
      const base = { Cookie: good.cookie, "Content-Type": "application/json" };
      expectRefused(await send(good, method, route, { ...base, Origin: "https://evil.example", "X-Duo-CSRF": good.csrf }, "{}"), 403, "UI_ORIGIN_REJECTED");
      expectRefused(await send(good, method, route, { ...base, Origin: good.server.origin }, "{}"), 403, "UI_CSRF_REJECTED");
      expectRefused(await send(good, method, route, { ...base, Origin: good.server.origin, "X-Duo-CSRF": good.csrf }, "{}"), 405, "UI_METHOD_NOT_ALLOWED");
    }
    expect(snapshot(good.root)).toEqual(before);
  });

  it("HEAD on a Decision route is not allowed and has no body", async () => {
    for (const route of DECISION_ROUTES) {
      const r = await send(good, "HEAD", route, { Cookie: good.cookie });
      expect(r.status, route).toBe(405);
      expect(r.body).toBe("");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("IDs over 128 characters, NUL, newline, an encoded slash or backslash, double encoding and non-ASCII are refused; 128 characters is a lookup", async () => {
    const longest = "D-" + "1".repeat(126);
    expect((await get(good, "/api/decisions/" + longest)).json().data).toMatchObject({ status: "not-found", id: longest });
    for (const id of ["D-" + "1".repeat(127), "D-" + "1".repeat(10_000), "D-001%00", "%00", "D-001%0A", "D-001%2F..%2F..%2Fproject.yaml", "D-001%5C..%5Cproject", "D-001%252F", "D%E2%80%91001"]) {
      const r = await get(good, "/api/decisions/" + id);
      expectRefused(r, 400, "UI_REQUEST_INVALID");
      expect(r.body.length, id.slice(0, 20)).toBeLessThan(500);
    }
  });

  it("list query parameters: unknown names (also __proto__ and constructor) and values over 200 characters are refused", async () => {
    for (const q of ["?__proto__=x", "?constructor=x", "?state=confirmed&debug=1", "?q=" + "a".repeat(201)]) expectRefused(await get(good, "/api/decisions" + q), 400, "UI_REQUEST_INVALID");
    const at = await get(good, "/api/decisions?q=" + "a".repeat(200));
    expect(at.status).toBe(200);
    expect(at.json().data.decisions).toEqual([]);
  });

  it("valid and hostile requests in parallel: valid answers stay identical, hostile ones are refused, Truth and the lock are untouched", async () => {
    const before = snapshot(good.root);
    const lock = lockState(good.root);
    const routes = ["/api/decisions", "/api/decisions/D-001", "/api/decisions/D-002", "/api/decisions/D-003"];
    const baseline = new Map(await Promise.all(routes.map(async (p) => [p, (await get(good, p)).json().data] as const)));
    const json = { Cookie: good.cookie, "Content-Type": "application/json" };
    const hostile: [() => Promise<Res>, number, string][] = [
      [() => send(good, "GET", "/api/decisions", { Cookie: good.cookie, Host: "evil.example" }), 403, "UI_HOST_REJECTED"],
      [() => send(good, "GET", "/api/decisions/D-002", { Cookie: forged(good) }), 401, "UI_SESSION_REQUIRED"],
      [() => get(good, "/api/decisions/D-002%2F..%2Fx"), 400, "UI_REQUEST_INVALID"],
      [() => get(good, "/api/decisions?sort=id"), 400, "UI_REQUEST_INVALID"],
      [() => send(good, "DELETE", "/api/decisions/D-002", { ...json, Origin: "https://evil.example" }, "{}"), 403, "UI_ORIGIN_REJECTED"],
      [() => send(good, "POST", "/api/proposals/P-001/confirm", { ...json, Origin: good.server.origin }, JSON.stringify({ confirmId: "P-001", previewDigest: "sha256:0" })), 403, "UI_CSRF_REJECTED"],
    ];
    const jobs: Promise<void>[] = [];
    for (let round = 0; round < 5; round++) {
      for (const p of routes) jobs.push(get(good, p).then((r) => { expect(r.status, p).toBe(200); expect(r.json().data).toEqual(baseline.get(p)); }));
      for (const [call, status, code] of hostile) jobs.push(call().then((r) => expectRefused(r, status, code)));
    }
    await Promise.all(jobs);
    expect(snapshot(good.root)).toEqual(before);
    expect(lockState(good.root)).toBe(lock);
    expect(git(good.root, "status", "--porcelain")).toBe("");
  });

  it("a UI confirm shows up in the Decision routes and a refused one does not; after a restart the old cookie no longer reads them", async () => {
    const root = repo(PROJECT);
    const service = createDecisionService({ root });
    const p1 = await service.propose(agent, { title: "Use Postgres", question: "database", answer: "postgres" });
    if (p1.value === undefined || (await service.confirm(human, p1.value.proposalId)).value === undefined) throw new Error("setup D-001");
    const p2 = await service.propose(agent, { title: "Use SQLite", question: "database", answer: "sqlite", supersedes: "D-001" });
    if (p2.value === undefined) throw new Error("setup P-002");
    commit(root);
    const c = await serve(root);
    const ids = async (cl: Client) => ((await get(cl, "/api/decisions")).json().data.decisions as Summary[]).map((d) => d.id);
    expect(await ids(c)).toEqual(["D-001"]);
    const digest = ((await get(c, "/api/proposals/P-002/preview")).json().data as { preview: { digest: string } }).preview.digest;
    const body = JSON.stringify({ confirmId: "P-002", previewDigest: digest });
    const json = { Cookie: c.cookie, "Content-Type": "application/json", "X-Duo-CSRF": c.csrf };
    const before = snapshot(root);
    expectRefused(await send(c, "POST", "/api/proposals/P-002/confirm", { ...json, Origin: "https://evil.example" }, body), 403, "UI_ORIGIN_REJECTED", c);
    expect(snapshot(root)).toEqual(before);
    expect(await ids(c)).toEqual(["D-001"]);
    const confirmed = await send(c, "POST", "/api/proposals/P-002/confirm", { ...json, Origin: c.server.origin }, body);
    expect(confirmed.status, confirmed.body).toBe(200);
    expect(confirmed.json().data).toMatchObject({ status: "confirmed" });
    expect(await ids(c)).toEqual(["D-001", "D-002"]);
    const d2 = (await get(c, "/api/decisions/D-002")).json().data as { decision: { lock: { status: string }; chain: unknown[] } };
    expect(d2.decision.lock.status).toBe("valid");
    expect(d2.decision.chain).toEqual([{ id: "D-001", state: "superseded", authority: "SUPERSEDED" }, { id: "D-002", state: "confirmed", authority: "CONFIRMED" }]);
    await c.server.close();
    servers.splice(servers.indexOf(c.server), 1);
    const fresh = await serve(root, c.server.port);
    for (const route of DECISION_ROUTES) {
      expectRefused(await send(fresh, "GET", route, { Cookie: c.cookie }), 401, "UI_SESSION_REQUIRED", c);
      expect((await get(fresh, route)).status, route).toBe(200);
    }
  });
});
