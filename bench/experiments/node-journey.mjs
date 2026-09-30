// T22-E: the installed-package journey on the running Node. CLI = argv[2] (the installed dist/duoctl.js on Node 24,
// or its CLI bundle directly on Node 22, which skips only the launcher's engines check). No file of the package is changed.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const CLI = process.argv[2];
if (!CLI) throw new Error("usage: node bench/experiments/node-journey.mjs <path to the installed dist/duoctl.js or its cli-*.js bundle>");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-node-journey-")));
const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", "-c", "core.autocrlf=false", ...a], { cwd: root, stdio: "pipe" });
git("-c", "init.defaultBranch=main", "init", "-q");
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src", "tasks.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
fs.writeFileSync(path.join(root, "src", "Main.java"), "class Main { void run() {} }\n");
git("add", "-A"); git("commit", "-qm", "init");
const env = { ...process.env, DUO_LOCALE: "" };
const run = (args, input = "") => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: "utf8", env }); return { code: r.status, warnings: [...new Set((r.stderr.match(/\w*Warning: [^\n]+/gu) ?? []))], json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
const steps = {};
const v = run(["--version", "--json"]); steps.version = { code: v.code, node: v.json?.node, warnings: v.warnings };
const i = run(["init", "--non-interactive", "--answers", "-", "--json"], "[]"); steps.init = { code: i.code, baseline: i.json?.result?.baseline?.status, warnings: i.warnings };
fs.appendFileSync(path.join(root, "src", "tasks.ts"), "export const sub = (a: number, b: number) => a - b;\n");
const x = run(["index", "--json"]); steps.index = { code: x.code, mode: x.json?.result?.mode, warnings: x.warnings };
const s = run(["status", "--json"]); steps.status = { code: s.code, index: s.json?.result?.index?.status, analysis: s.json?.result?.analysis?.languages?.map((l) => l.language + ":" + l.level), warnings: s.warnings };
const c = run(["context", "add", "--json"]); steps.context = { code: c.code, status: c.json?.result?.context?.status, code_items: c.json?.result?.context?.packet?.code?.length, warnings: c.warnings };
const rv = run(["review", "--json"]); steps.review = { code: rv.code, verdict: rv.json?.result?.verdict, warnings: rv.warnings };
// MCP: initialize + tools/list over stdio
steps.mcp = await new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, "mcp", "--root", root], { env });
  let out = "", err = "";
  const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  p.stdout.on("data", (d) => { out += d; const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (lines.some((m) => m.id === 1) && !lines.some((m) => m.id === 2)) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }
    const list = lines.find((m) => m.id === 2); if (list) { p.kill(); resolve({ tools: list.result?.tools?.length, warnings: [...new Set(err.match(/\w*Warning: [^\n]+/gu) ?? [])], stdoutClean: lines.length === out.split("\n").filter(Boolean).length }); } });
  p.stderr.on("data", (d) => { err += d; });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t22", version: "1" } } });
  setTimeout(() => { p.kill(); resolve({ error: "timeout", err: err.slice(0, 300) }); }, 60000);
});
// UI: start, open the session link, read /api/overview
steps.ui = await new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, "ui"], { cwd: root, env });
  let out = "", err = "";
  p.stderr.on("data", (d) => { err += d; });
  p.stdout.on("data", async (d) => { out += d; const m = /DUO UI: (\S+)/u.exec(out); if (m && !p.done) { p.done = true;
    const launch = await fetch(m[1], { redirect: "manual", headers: { Connection: "close" } }); const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0];
    const o = await fetch(new URL("/api/overview", m[1]), { headers: { Cookie: cookie, Connection: "close" } });
    const body = await o.json(); p.kill(); resolve({ overview: o.status, format: body.format, index: body.data?.status?.index?.status, warnings: [...new Set(err.match(/\w*Warning: [^\n]+/gu) ?? [])] }); } });
  setTimeout(() => { p.kill(); resolve({ error: "timeout", err: err.slice(0, 300) }); }, 60000);
});
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(JSON.stringify({ node: process.version, cli: path.basename(CLI), steps }, null, 1));

