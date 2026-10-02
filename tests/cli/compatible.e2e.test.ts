/**
 * T27.1 openai-compatible provider through the built duoctl (and, in pnpm test:conformance, the installed package):
 * review --semantic and MCP includeSemanticAssist reach a local loopback endpoint that speaks the Responses or the
 * Chat Completions wire format. The test records each request (path, whether the key was sent, body) and answers
 * like a compatible endpoint. No internet: the endpoint is http://127.0.0.1.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLI_MAIN } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const KEY = "gms-e2e-KEY-0123456789abcdef";
const OPENAI_SECRET = "sk-proj-DUOCOMPATE2ECANARY0123456789ab";
const AWS_SECRET = "AKIADUOCOMPATE2ECAN1";
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };

interface Seen { readonly path: string; readonly authorized: boolean; readonly body: Record<string, unknown> }
let behavior: "ok" | "redirect" | number = "ok";
const seen: Seen[] = [];
const stolen: string[] = [];
let server: http.Server;
let thief: http.Server;
let origin = "";
let root = "";
let yaml = "";

/** Answers every CLAIM in the request as ALIGNED, citing its first evidence ID (as a well-behaved endpoint would). */
function answerText(input: string): string {
  const claims: { claim_id: string; alignment: string; evidence_ids: string[]; reason: string }[] = [];
  let current: string | undefined;
  for (const line of input.split("\n")) {
    const c = /^CLAIM (\S+)/u.exec(line);
    if (c !== null) current = c[1];
    const e = /^evidence: (.+)$/u.exec(line);
    if (e !== null && current !== undefined) { claims.push({ claim_id: current, alignment: "ALIGNED", evidence_ids: [e[1]?.split(", ")[0] ?? ""], reason: "matches" }); current = undefined; }
  }
  return JSON.stringify({ claims });
}

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  let raw = "";
  req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
  req.on("end", () => {
    const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
    const p = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path: p, authorized: req.headers.authorization === `Bearer ${KEY}`, body });
    if (behavior === "redirect") { res.writeHead(307, { location: `http://127.0.0.1:${(thief.address() as { port: number }).port}${p}` }).end(); return; }
    if (typeof behavior === "number") { res.writeHead(behavior, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "nope" } })); return; }
    const chat = p.endsWith("/chat/completions");
    const input = chat ? String((body.messages as { content: string }[])[1]?.content ?? "") : String(body.input ?? "");
    const text = answerText(input);
    const answer = chat
      ? { id: "c", object: "chat.completion", model: "m-served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }
      : { id: "r", object: "response", status: "completed", model: "m-served", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 11, output_tokens: 7 } };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
}

function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_MAIN, ...args], { cwd: root, env: { ...env, DUO_LOCALE: "" }, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
const baseEnv = () => { const e: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "sk-official-NOTUSED0123456789abcd" }; delete e.OPENAI_CUSTOM_HEADERS; return e; };
const withKey = () => ({ ...baseEnv(), GMS_E2E_KEY: KEY });
const llm = (transport: string, mode: string, extra = "") => `llm:\n  provider: openai-compatible\n  model: m-1\n  base_url: ${origin}/gw/v1/\n  transport: ${transport}\n  api_key_env: GMS_E2E_KEY\n  structured_output: ${mode}\n  cache: false\n${extra}`;
async function configure(block: string) {
  fs.writeFileSync(path.join(root, ".duo-project", "project.yaml"), yaml + block);
  expect((await run(["index", "--json"], baseEnv())).code).toBe(0);
}
const review = async (env: NodeJS.ProcessEnv = withKey()) => {
  const r = await run(["review", "--task", "RPT-01", "--semantic", "--json"], env);
  expect(r.code, r.stderr).toBe(0);
  return { ...r, result: JSON.parse(r.stdout).result };
};
const noSecret = (...texts: string[]) => { for (const s of texts) for (const x of [OPENAI_SECRET, AWS_SECRET, KEY]) expect(s).not.toContain(x); };

beforeAll(async () => {
  server = http.createServer(handle);
  thief = http.createServer((req, res) => { stolen.push(String(req.headers.authorization ?? "none")); res.writeHead(200).end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => thief.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-compat-")));
  fs.cpSync(path.join(REPO, "fixtures", "review", "app"), root, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...a], { cwd: root, env: gitEnv, windowsHide: true, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const file = path.join(root, "src", "report", "build-report.ts");
  // The changed line carries credential-shaped text: it is part of the evidence excerpt DUO selects.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Math.floor(cents / 100)", `Math.round(cents / 100) /* ${OPENAI_SECRET} ${AWS_SECRET} */`));
  yaml = fs.readFileSync(path.join(root, ".duo-project", "project.yaml"), "utf8").trimEnd() + "\n";
});
afterAll(() => {
  server?.close();
  thief?.close();
  if (root !== "") fs.rmSync(root, { recursive: true, force: true });
});

describe("openai-compatible through duoctl review --semantic (T27.1)", () => {
  /** The deterministic review under the same project.yaml, without semantic assistance. */
  const plainClaims = async () => { const r = await run(["review", "--task", "RPT-01", "--json"], withKey()); return JSON.parse(r.stdout).result.claims as unknown[]; };

  it("each transport and output mode: one request to the configured prefix with the key, its own format fields, [REDACTED] instead of secrets, DUO-validated supplement, deterministic claims unchanged", async () => {
    for (const [transport, mode] of [["responses", "json-schema"], ["chat-completions", "json-object"], ["chat-completions", "prompt-only"], ["responses", "prompt-only"]] as const) {
      await configure(llm(transport, mode));
      const claims = await plainClaims();
      seen.length = 0;
      behavior = "ok";
      const r = await review();
      const label = `${transport} × ${mode}`;
      expect(r.result.semanticAssist, label).toMatchObject({ status: "success", calls: 1, provider: { id: "openai-compatible", model: "m-served" } });
      expect(r.result.semanticAssist.claims.length, label).toBeGreaterThan(0);
      expect(r.result.claims, label).toEqual(claims);
      expect(seen.map((s) => s.path), label).toEqual([`/gw/v1/${transport === "responses" ? "responses" : "chat/completions"}`]);
      const s = seen[0] as Seen;
      expect(s.authorized, label).toBe(true);
      const sent = JSON.stringify(s.body);
      noSecret(sent);
      expect(sent, label).toContain("[REDACTED]");
      if (transport === "responses") {
        expect(s.body.store, label).toBe(false);
        expect(Boolean(s.body.text), label).toBe(mode !== "prompt-only");
      } else {
        expect(s.body).not.toHaveProperty("store");
        expect(s.body.response_format, label).toEqual(mode === "json-object" ? { type: "json_object" } : undefined);
      }
      noSecret(r.stdout, r.stderr);
      expect(r.stdout).not.toContain("/gw/v1");
    }
  });

  it("no fallback and no retry: a refused json-schema request, a 404 transport and a 500 are one request each; a redirect is not followed", async () => {
    for (const [transport, mode, status] of [["chat-completions", "json-schema", 400], ["responses", "json-object", 404], ["chat-completions", "prompt-only", 500]] as const) {
      await configure(llm(transport, mode));
      seen.length = 0;
      behavior = status;
      const r = await review();
      expect(r.result.semanticAssist, String(status)).toMatchObject({ status: "failed", failure: status === 500 ? "unavailable" : "provider-error" });
      expect(seen.map((s) => s.path)).toEqual([`/gw/v1/${transport === "responses" ? "responses" : "chat/completions"}`]);
    }
    await configure(llm("chat-completions", "prompt-only"));
    seen.length = 0;
    behavior = "redirect";
    const r = await review();
    expect(r.result.semanticAssist).toMatchObject({ status: "failed", failure: "provider-error" });
    expect(seen).toHaveLength(1);
    expect(stolen).toEqual([]);
    behavior = "ok";
  });

  it("the local answer cache: the same review is a cache hit with no request; another transport is a new request", async () => {
    await configure(llm("chat-completions", "prompt-only").replace("  cache: false\n", ""));
    seen.length = 0;
    expect((await review()).result.semanticAssist).toMatchObject({ calls: 1, cacheHits: 0 });
    expect((await review()).result.semanticAssist).toMatchObject({ calls: 0, cacheHits: 1 });
    expect(seen).toHaveLength(1);
    await configure(llm("responses", "prompt-only").replace("  cache: false\n", ""));
    expect((await review()).result.semanticAssist).toMatchObject({ calls: 1, cacheHits: 0 });
    expect(seen).toHaveLength(2);
    const cache = path.join(root, ".duo-project", "cache", "llm");
    for (const f of fs.readdirSync(cache, { recursive: true, encoding: "utf8" }).filter((x) => fs.statSync(path.join(cache, x)).isFile())) {
      const text = fs.readFileSync(path.join(cache, f), "utf8");
      noSecret(text);
      expect(text).not.toContain("/gw/v1");
    }
  });

  it("MCP includeSemanticAssist takes the same path: one request, [REDACTED], a validated supplement", async () => {
    await configure(llm("responses", "json-schema"));
    seen.length = 0;
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI_MAIN, "mcp", "--root", root], cwd: root, stderr: "pipe", env: { ...getDefaultEnvironment(), GMS_E2E_KEY: KEY, DUO_LOCALE: "" } });
    const client = new Client({ name: "duo-compat-e2e", version: "0" });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: "duo_review_changes", arguments: { task: "RPT-01", includeSemanticAssist: true } });
      expect((r.structuredContent as { semanticAssist: unknown }).semanticAssist).toMatchObject({ status: "success", calls: 1, provider: { id: "openai-compatible" } });
      expect(seen).toHaveLength(1);
      noSecret(JSON.stringify(seen[0]?.body), JSON.stringify(r));
      expect(JSON.stringify(seen[0]?.body)).toContain("[REDACTED]");
    } finally {
      await client.close();
    }
  });
});

describe("openai-compatible configuration, doctor and status (T27.1)", () => {
  it("doctor and status show provider, transport and the endpoint origin only; a missing key is a warning; no request", async () => {
    await configure(llm("chat-completions", "json-object"));
    seen.length = 0;
    const d = await run(["doctor", "--json"], withKey());
    const check = (JSON.parse(d.stdout).result.checks as { id: string }[]).find((c) => c.id === "llm.configuration");
    expect(check).toMatchObject({ status: "ok", reason: "configured", facts: { provider: "openai-compatible", model: "m-1", transport: "chat-completions", structuredOutput: "json-object", endpoint: origin, credentialEnv: "GMS_E2E_KEY" } });
    const human = await run(["doctor"], withKey());
    expect(human.stdout).toContain(`openai-compatible · m-1 · chat-completions · json-object · ${origin} · key from GMS_E2E_KEY`);
    const status = await run(["status"], withKey());
    expect(status.stdout).toMatch(new RegExp(`LLM: configured · openai-compatible m-1 · chat-completions · ${origin.replaceAll(".", "\\.")}`, "u"));
    for (const out of [d.stdout, human.stdout, status.stdout]) { expect(out).not.toContain("/gw/v1"); expect(out).not.toContain(KEY); }
    const missing = await run(["doctor", "--json"], baseEnv());
    expect(missing.code).toBe(0);
    expect((JSON.parse(missing.stdout).result.checks as { id: string }[]).find((c) => c.id === "llm.configuration")).toMatchObject({ status: "warning", reason: "credential-missing", facts: { credentialEnv: "GMS_E2E_KEY" } });
    expect(seen).toEqual([]);
  });

  it("a refused base_url (private-network http, user information, the official OpenAI API) is a project.yaml error that never repeats the value", async () => {
    for (const [url, message] of [["http://192.168.1.10/v1", /loopback/u], ["https://user:hunter2@gateway.example/v1", /user information/u], ["https://api.openai.com/v1", /openai-responses/u]] as const) {
      fs.writeFileSync(path.join(root, ".duo-project", "project.yaml"), yaml + llm("responses", "json-schema").replace(`${origin}/gw/v1/`, url));
      const r = await run(["status", "--json"], withKey());
      expect(r.code, url).toBe(1);
      expect(r.stdout, url).toMatch(message);
      expect(r.stdout + r.stderr).not.toContain("hunter2");
      expect(r.stdout + r.stderr).not.toContain("192.168.1.10");
    }
    await configure("");
  });

  it("provider none: --semantic makes no request", async () => {
    await configure("llm:\n  provider: none\n");
    seen.length = 0;
    expect((await review()).result.metrics.llmCalls).toBe(0);
    expect(seen).toEqual([]);
  });
});
