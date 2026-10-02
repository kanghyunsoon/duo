/**
 * TASK-020 release conformance, RC-only checks. Run by pnpm test:conformance against the installed release
 * candidate (DUO_CONFORMANCE_CLI); under plain pnpm test it runs against the workspace build, which must
 * satisfy the same contract. Everything goes through the duoctl executable: CLI, MCP (duoctl mcp) and the
 * local UI (duoctl ui). No workspace code is called.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLI_MAIN, duoctl, existingProject } from "../cli/support.js";
import { duoctlBin, envWithPath } from "../install/support.js";
import { startMcp } from "../mcp/support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
// A key-shaped canary in the environment. Provider none never reads it; it must not appear in any file DUO writes.
const KEY_CANARY = "sk-proj-DUOCONFORMANCECANARY0123456789abcdef";
const env = { ...process.env, OPENAI_API_KEY: KEY_CANARY, DUO_LOCALE: "" };

interface Repo { readonly root: string; git(...a: string[]): string; edit(f: string, from: string, to: string): void; write(f: string, t: string): void }
function fixture(name: string): Repo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-conf-")));
  temps.push(root);
  fs.cpSync(path.join(REPO, "fixtures", ...name.split("/")), root, { recursive: true });
  const r: Repo = {
    root,
    git: (...a) => execFileSync("git", a, { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true }),
    write: (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); },
    edit: (f, from, to) => { const t = fs.readFileSync(path.join(root, f), "utf8"); if (!t.includes(from)) throw new Error(f + " lacks " + from); fs.writeFileSync(path.join(root, f), t.replace(from, to)); },
  };
  r.git("-c", "init.defaultBranch=main", "init", "-q");
  r.git("config", "core.autocrlf", "false");
  r.git("add", "-A");
  r.git("commit", "-qm", "fixture");
  return r;
}
const cli = (r: Repo, args: string[], input?: string) => duoctl(r.root, args, input, env);
const index = (r: Repo) => expect(cli(r, ["index", "--json"]).code).toBe(0);
const packetIds = (packet: { intent: { requirements: { id: string }[]; constraints: { id: string }[] }; decisions: { active: { id: string }[] }; code: { id: string }[]; tests: { id: string }[]; issues: { id: string }[] }) =>
  new Set([...packet.intent.requirements, ...packet.intent.constraints, ...packet.decisions.active, ...packet.code, ...packet.tests, ...packet.issues].map((i) => i.id));

describe("RC: JSON contracts and Context quality (context fixture)", () => {
  let r: Repo;
  beforeAll(() => { r = fixture("context/app"); index(r); });

  it("status, context, review, trace, impact: duo.cli.<command>/1 envelopes around the frozen /1 payloads", () => {
    const expectFormat = (args: string[], envelope: string, payload: string) => {
      const j = cli(r, [...args, "--json"]).json();
      expect(j.format, args[0]).toBe(envelope);
      expect(j.result.format, args[0]).toBe(payload);
      return j.result;
    };
    expectFormat(["status"], "duo.cli.status/1", "duo.status/1");
    const c = expectFormat(["context", "AUTH-03"], "duo.cli.context/1", "duo.context/1");
    expect(c.context.packet.format).toBe("duo.context-packet/1");
    expectFormat(["review"], "duo.cli.review/1", "duo.review/1");
    expectFormat(["trace", "AUTH-03"], "duo.cli.trace/1", "duo.trace/1");
    expectFormat(["impact", "AUTH-03"], "duo.cli.impact/1", "duo.impact/1");
  });

  it("the benchmark tasks' expected entities are in the Packet; the Packet never exceeds the requested budget", () => {
    const expected: Record<string, string[]> = {
      "AUTH-03": ["req:AUTH-03", "dec:D-015", "sym:src/auth/AuthService.ts#AuthService.refresh", "test:src/auth/AuthService.test.ts#AuthService > refresh returns a new access token"],
      "AuthService.refresh": ["sym:src/auth/AuthService.ts#AuthService.refresh", "req:AUTH-03"],
      "GAME-42": ["issue:GAME-42", "req:AUTH-03"],
      "Refresh Token": ["req:AUTH-03"],
    };
    for (const [task, ids] of Object.entries(expected)) {
      const p = cli(r, ["context", task, "--json"]).json().result.context.packet;
      const have = packetIds(p);
      expect(ids.filter((id) => !have.has(id)), task).toEqual([]);
      expect(p.metrics.budget.used, task).toBeLessThanOrEqual(p.metrics.budget.total);
      expect(p.metrics.llmCalls).toBe(0);
    }
    for (const budget of [1000, 2500]) {
      const p = cli(r, ["context", "AUTH-03", "--budget", String(budget), "--json"]).json().result.context.packet;
      expect(p.metrics.budget.total).toBe(budget);
      expect(p.metrics.budget.used).toBeLessThanOrEqual(budget);
    }
    expect(cli(r, ["context", "fix normalize", "--json"]).json().result.status).toBe("ambiguous");
    // T26.1: the human output says how to give an exact starting point, and that advice holds (a path is one).
    const hint = cli(r, ["context", "fix normalize"]);
    expect(hint.stdout).toMatch(/repository-relative file path/u);
    expect(cli(r, ["context", "fix normalize src/util/text.ts", "--json"]).json().result.status).not.toBe("ambiguous");
  });
});

describe("RC: Review matrix, exit semantics and exit codes (review fixture)", () => {
  let r: Repo;
  beforeAll(() => { r = fixture("review/app"); index(r); });
  const scenario = (mutate: () => void, task?: string) => {
    r.git("reset", "-q", "--hard");
    r.git("clean", "-fdq");
    mutate();
    index(r);
    const args = ["review", ...(task === undefined ? [] : ["--task", task])];
    return { json: cli(r, [...args, "--json"]), args };
  };
  const cases = {
    PASS: [() => r.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("refresh token expired");'), "AUTH-03"],
    WARN: [() => r.edit("src/admin/metrics-export.ts", '.join("\\n")', '.sort().join("\\n")'), "AUTH-03"],
    BLOCK: [() => r.write("src/auth/session-store.ts", "export class ServerSessionStore { save() {} }\n"), "AUTH-03"],
    ASK: [() => r.edit("src/presence/presence-service.ts", "members.add(userId);", "members.add(userId.trim());"), undefined],
  } as const;
  const failOnWarn = { PASS: 0, WARN: 2, ASK: 3, BLOCK: 4 } as const;

  for (const [verdict, [mutate, task]] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
    it(verdict + ": claims cite evidence, the verdict basis names its claims or gaps, exit 0 without --fail-on", () => {
      const { json, args } = scenario(mutate, task);
      expect(json.code).toBe(0);
      const rv = json.json().result;
      expect(rv.verdict).toBe(verdict);
      const evidence = new Set(rv.evidence.map((e: { id: string }) => e.id));
      for (const c of rv.claims) for (const id of c.evidenceIds) expect(evidence.has(id), c.rule).toBe(true);
      const basis = rv.verdictBasis as { blocking: string[]; ask: string[]; warn: string[] };
      if (verdict === "BLOCK") expect(basis.blocking.length).toBeGreaterThan(0);
      if (verdict === "ASK") { expect(basis.ask.length).toBeGreaterThan(0); expect(rv.gaps.requiresHumanInput).toBe(true); }
      if (verdict === "WARN") expect(basis.warn.length).toBeGreaterThan(0);
      if (verdict === "PASS") expect([...basis.blocking, ...basis.ask, ...basis.warn]).toEqual([]);
      expect(rv.metrics.llmCalls).toBe(0);
      expect(cli(r, [...args, "--fail-on", "warn"]).code).toBe(failOnWarn[verdict]);
      expect(cli(r, [...args, "--fail-on", "block"]).code).toBe(verdict === "BLOCK" ? 4 : 0);
      // PASS wording: no violation found in the available evidence, never "bug-free".
      const human = cli(r, args).stdout;
      expect(human).not.toMatch(/bug[- ]free|fully (?:correct|aligned)/iu);
    });
  }

  it("exit codes: not-initialized 5, invalid argument 1, index-required 6, confirmation-required 6", () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-conf-plain-")));
    temps.push(plain);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: plain, windowsHide: true });
    const ni = duoctl(plain, ["status", "--json"], undefined, env);
    expect(ni.code).toBe(5);
    expect(ni.json().ok).toBe(false);
    expect(cli(r, ["review", "--fail-on", "sometimes"]).code).toBe(1);
    expect(cli(r, ["trace", "AUTH-03", "--depth", "9"]).code).toBe(1);
    expect(cli(r, ["frobnicate"]).code).toBe(1);
    r.git("reset", "-q", "--hard");
    r.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("expired");');
    const stale = cli(r, ["review", "--json"]);
    expect(stale.code).toBe(6);
    expect(stale.json().result.status).toBe("index-required");
    // With duoctl on PATH (as after an install) and no --yes, a non-interactive install only plans.
    const install = duoctl(r.root, ["install", "codex", "--non-interactive", "--json"], undefined, { ...envWithPath([duoctlBin(temps)]), OPENAI_API_KEY: KEY_CANARY });
    expect(install.code).toBe(6);
    expect(install.json().result.status).toBe("confirmation-required");
    r.git("checkout", "--", ".");
  });
});

function startUi(root: string): Promise<{ origin: string; launch: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [CLI_MAIN, "ui"], { cwd: root, env, windowsHide: true });
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no URL printed: " + out)), 120_000);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const m = /DUO UI: (http:\/\/127\.0\.0\.1:(\d+))\/\?session=[\w-]+/u.exec(out);
      // stop waits for the process to exit: on Windows a live child keeps its cwd (the fixture) from being removed.
      const stop = () => new Promise<void>((done) => { if (child.exitCode !== null || child.signalCode !== null) return done(); child.once("exit", () => done()); child.kill(); });
      if (m !== null) { clearTimeout(timer); resolve({ origin: m[1] as string, launch: m[0].slice("DUO UI: ".length), stop }); }
    });
    child.once("exit", (code) => reject(new Error("ui exited " + code + ": " + out)));
  });
}

describe("RC: local UI — same operations as CLI/MCP, security, no external resources, Decision Lock", () => {
  let r: Repo;
  let ui: { origin: string; launch: string; stop: () => Promise<void> };
  let cookie = "";
  let csrf = "";
  // T21 (C213): every request to the UI opens its own connection. The CLI calls between requests run through
  // spawnSync and block this process, so a pooled keep-alive socket could be reused just as the server's 5 s
  // idle timeout closes it, and the request failed with ECONNRESET on slow Windows runners. Connection: close
  // leaves no idle socket to reuse. The UI server itself is unchanged.
  const CLOSE = { Connection: "close" } as const;
  beforeAll(async () => {
    r = fixture("review/app");
    index(r);
    ui = await startUi(r.root);
    const opened = await fetch(ui.launch, { redirect: "manual", headers: CLOSE });
    cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    csrf = String(((await (await fetch(ui.origin + "/api/session", { headers: { ...CLOSE, Cookie: cookie } })).json()) as { data: { csrf: string } }).data.csrf);
  });
  afterAll(async () => { await ui?.stop(); });
  const get = async (p: string, headers: Record<string, string> = {}) => fetch(ui.origin + p, { headers: { ...CLOSE, Cookie: cookie, ...headers } });
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(ui.origin + p, {
    method: "POST", body: JSON.stringify(body), headers: { ...CLOSE, Cookie: cookie, Origin: ui.origin, "Content-Type": "application/json", "X-Duo-CSRF": csrf, ...headers },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API payloads, asserted by shape
  const data = async (res: Response): Promise<any> => ((await res.json()) as { data: unknown }).data;

  it("overview, context, review and graph come from the same operations as the CLI (same semantic results)", async () => {
    const status = cli(r, ["status", "--json"]).json().result;
    const overview = await data(await get("/api/overview"));
    for (const k of ["index", "analysis", "truth", "baseline", "pendingDecisions"]) expect(overview.status[k], k).toEqual(status[k]);
    const ctx = cli(r, ["context", "RPT-01", "--json"]).json().result;
    const uiCtx = await data(await post("/api/context", { task: "RPT-01" }));
    expect(uiCtx.context.packet.dependencyDigest).toBe(ctx.context.packet.dependencyDigest);
    expect(uiCtx.gaps.requiresHumanInput).toBe(ctx.gaps.requiresHumanInput);
    r.edit("src/report/build-report.ts", "Math.floor(cents / 100)", "Math.round(cents / 100)");
    index(r);
    const rv = cli(r, ["review", "--task", "RPT-01", "--json"]).json().result;
    const uiRv = await data(await post("/api/review", { task: "RPT-01" }));
    expect(uiRv.verdict).toBe(rv.verdict);
    expect(uiRv.claims.map((c: { id: string }) => c.id)).toEqual(rv.claims.map((c: { id: string }) => c.id));
    expect(uiRv.evidence.map((e: { id: string }) => e.id)).toEqual(rv.evidence.map((e: { id: string }) => e.id));
    const trace = cli(r, ["trace", "RPT-01", "--depth", "2", "--json"]).json().result;
    const graph = await data(await get("/api/graph?node=RPT-01&kind=trace&depth=2"));
    expect(graph.nodes.map((n: { id: string }) => n.id).sort()).toEqual(trace.nodes.map((n: { id: string }) => n.id).sort());
    for (const page of ["/api/direction", "/api/proposals", "/api/reviews"]) expect((await get(page)).status, page).toBe(200);
    r.git("checkout", "--", ".");
    index(r);
  });

  it("security: loopback only, bad Host, missing session, foreign Origin, missing CSRF and GET mutations are refused", async () => {
    expect(new URL(ui.origin).hostname).toBe("127.0.0.1");
    // fetch cannot set Host; a raw request can (DNS rebinding shape).
    const badHost = await new Promise<number>((resolve, reject) => {
      const u = new URL(ui.origin);
      const req = http.request({ host: u.hostname, port: Number(u.port), path: "/api/overview", headers: { Host: "evil.example", Cookie: cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(badHost).toBe(403);
    expect((await fetch(ui.origin + "/api/overview", { headers: CLOSE })).status).toBe(401);
    expect((await post("/api/proposals/P-001/reject", {}, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post("/api/proposals/P-001/reject", {}, { "X-Duo-CSRF": "" })).status).toBe(403);
    expect((await get("/api/proposals/P-001/confirm")).status).toBe(405);
    expect((await fetch(ui.origin + "/api/context", { method: "POST", body: "{}", headers: { ...CLOSE, Cookie: cookie, "Content-Type": "application/json" } })).status).toBe(403);
  });

  it("no external network by default: the page and styles reference no remote origin, and CSP allows only the server itself", async () => {
    const page = await get("/");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'none'/u);
    for (const d of ["script-src", "style-src", "connect-src", "font-src"]) expect(csp).toMatch(new RegExp(d + " 'self'(?:;|$)", "u"));
    expect(csp).not.toMatch(/https?:\/\//u);
    const html = await page.text();
    const css = await (await get("/assets/app.css")).text();
    expect(html + css).not.toMatch(/(?:src|href)=["']?https?:\/\/|url\(\s*["']?https?:\/\/|@import\s+["']?https?:/iu);
  });

  it("Decision Lock: MCP can only propose; the UI confirms once, a stale second confirm is refused, the Decision is committed", async () => {
    const s = await startMcp(r.root);
    try {
      const { tools } = await s.client.listTools();
      expect(tools).toHaveLength(9);
      expect(tools.map((t) => t.name).filter((n) => /confirm|reject|write|delete|record|index/u.test(n))).toEqual([]);
      const proposed = await s.call("duo_propose_decision", { title: "Round reports half up", question: "report_rounding", answer: "round half up", governs: { requirements: ["RPT-01"] }, agent: "codex" });
      const id = proposed.structuredContent.proposalId as string;
      expect(proposed.structuredContent).toMatchObject({ format: "duo.proposal/1", confirmed: false });
      const stale = await data(await get("/api/proposals")); // "tab B" loads the list before tab A confirms
      expect(stale.proposals.find((p: { id: string }) => p.id === id)?.status).toBe("pending");
      const first = await data(await post("/api/proposals/" + id + "/confirm", { confirmId: id }));
      expect(first.status).toBe("confirmed");
      const second = await data(await post("/api/proposals/" + id + "/confirm", { confirmId: id }));
      expect(second).toMatchObject({ status: "failed", diagnostics: [expect.objectContaining({ code: "PROPOSAL_NOT_PENDING" })] });
      const refreshed = await data(await get("/api/proposals"));
      // After a refresh the proposal is no longer pending and the Decision is committed.
      expect(refreshed.proposals.filter((p: { id: string; status: string }) => p.id === id && p.status === "pending")).toEqual([]);
      const direction = await data(await get("/api/direction"));
      expect(direction.decisions.find((d: { id: string }) => d.id === first.result.decisionId)?.label).toBe("CONFIRMED");
      expect((await s.call("duo_get_decision", { id: first.result.decisionId })).structuredContent.status).not.toBe("not-found");
    } finally {
      await s.close();
    }
  });
});

describe("RC: sparse Truth, language matrix, privacy", () => {
  it("AC-020-02 self fixture: DUO's own SDD documents as Truth; trace REQ-CONTEXT-001 finds ADR-005 and TASK-010", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-conf-self-")));
    temps.push(root);
    execFileSync("git", ["clone", "-q", "--no-hardlinks", REPO, root], { windowsHide: true, stdio: "pipe" });
    const duo = path.join(root, ".duo-project");
    for (const d of ["specs", "decisions", "milestones"]) fs.mkdirSync(path.join(duo, d), { recursive: true });
    fs.writeFileSync(path.join(duo, "project.yaml"), "schema_version: 1\nname: duo\ncurrent_milestone: M4\n");
    fs.copyFileSync(path.join(root, "docs", "01-requirements.md"), path.join(duo, "specs", "01-requirements.md"));
    for (const f of fs.readdirSync(path.join(root, "docs", "adr")).filter((x) => /^ADR-\d+.*\.md$/u.test(x))) fs.copyFileSync(path.join(root, "docs", "adr", f), path.join(duo, "decisions", f));
    fs.copyFileSync(path.join(root, "docs", "tasks", "TASKS.md"), path.join(duo, "milestones", "TASKS.md"));
    fs.copyFileSync(path.join(root, "docs", "12-roadmap.md"), path.join(duo, "milestones", "12-roadmap.md"));
    const run = (args: string[]) => duoctl(root, args, undefined, env);
    const status = run(["status", "--json"]).json();
    expect(status.result.truth.requirements).toBeGreaterThan(40);
    expect(status.diagnostics).toEqual([]);
    expect(run(["index", "--json"]).code).toBe(0);
    const ids = run(["trace", "REQ-CONTEXT-001", "--depth", "2", "--json"]).json().result.nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["req:REQ-CONTEXT-001", "dec:ADR-005", "issue:TASK-010"]));
  });

  it("sparse Truth (0 requirements, decisions, constraints): index, status, context, review, trace, impact all work", () => {
    const p = existingProject(temps);
    const run = (args: string[], input?: string) => duoctl(p.root, args, input, env);
    expect(run(["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const status = run(["status", "--json"]).json().result;
    expect(status.truth).toMatchObject({ requirements: 0, decisions: 0, constraints: 0 });
    p.edit("src/scheduler.ts", "% 7", "% 5");
    expect(run(["index", "--json"]).code).toBe(0);
    expect(run(["context", "Scheduler.next", "--json"]).json().result.status).toBe("ready");
    expect(run(["review", "--json"]).json().result.status).toBe("ready");
    expect(run(["trace", "src/scheduler.ts", "--json"]).code).toBe(0);
    expect(run(["impact", "src/scheduler.ts", "--json"]).json().result.format).toBe("duo.impact/1");
  });

  it("the README language table is what the RC reports: TS/JS L2, Java/C#/C++/Python L1, anything else file-level L0", () => {
    const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
    const row = (level: string) => readme.split(/\r?\n/u).find((l) => l.startsWith("| " + level + " |")) ?? "";
    expect(row("L2")).toMatch(/TypeScript \/ JavaScript/u);
    expect(row("L1")).toMatch(/TypeScript \/ JavaScript \/ Java \/ C# \/ C\+\+ \/ Python/u);
    expect(row("L0")).toMatch(/모든 Git repository/u);
    const r = fixture("languages/polyglot");
    expect(cli(r, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const analysis = cli(r, ["status", "--json"]).json().result.analysis;
    const levels = Object.fromEntries(analysis.languages.map((l: { language: string; level: string }) => [l.language, l.level]));
    expect(levels).toMatchObject({ typescript: "L2", java: "L1", csharp: "L1", cpp: "L1", python: "L1" });
    expect(Object.entries(levels).filter(([lang]) => !["typescript", "tsx", "javascript", "java", "csharp", "cpp", "python"].includes(lang))).toEqual([]);
    expect(analysis.fileOnly.level).toBe("L0");
    expect(analysis.fileOnly.files).toBeGreaterThan(0);
  });

  it("after a full workflow no file DUO wrote holds the API key; metrics hold no task, source or diff text", () => {
    const r = fixture("review/app");
    const TASK = "CONFORMANCE-TASK-TEXT-canary-7f3a refresh tokens";
    const SOURCE = "conformance_source_canary_91c2";
    index(r);
    r.edit("src/auth/token-service.ts", 'throw new Error("expired refresh token");', 'throw new Error("' + SOURCE + '");');
    index(r);
    cli(r, ["context", TASK, "--json"]);
    cli(r, ["review", "--task", "AUTH-03", "--record", "--json"]);
    cli(r, ["status", "--json"]);
    const files = fs.readdirSync(path.join(r.root, ".duo-project"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(fs.readFileSync(f).toString("latin1").includes(KEY_CANARY), f).toBe(false);
    const metrics = fs.readFileSync(path.join(r.root, ".duo-project", "runtime", "metrics.jsonl"), "utf8");
    expect(metrics.length).toBeGreaterThan(0);
    for (const needle of [TASK, "canary-7f3a", SOURCE, "expired refresh token", KEY_CANARY]) expect(metrics.includes(needle), needle).toBe(false);
    const records = fs.readdirSync(path.join(r.root, ".duo-project", "reviews")).filter((f) => f.startsWith("review-"));
    expect(records.length).toBe(1);
    const record = fs.readFileSync(path.join(r.root, ".duo-project", "reviews", records[0] as string), "utf8");
    expect(record.includes(SOURCE)).toBe(false);
    expect(record.includes(KEY_CANARY)).toBe(false);
  });
});
