#!/usr/bin/env node
// Value Validation 01, Phase 4 (T81, Issue #8): does real Codex find and use DUO's MCP tools, published 0.3.2 vs 0.3.3?
// Installs each version from the npm registry into its own prefix (empty npm config, fresh cache), sets up one small
// repository per version with that version's duoctl (init, install codex, index), and alternates the versions run by
// run with the same prompt, model, sandbox (read-only) and time limit. Per session it records whether a duo-director MCP
// tool was called, whether the first call succeeded, whether the agent fell back to the duoctl CLI, the time until the
// first DUO tool event, wall time and the tokens Codex reports. It also measures each server's initialize time without
// Codex (no quota). It uses the runner's own Codex login (no credential is copied) and therefore needs --model and
// --i-understand-this-uses-codex; --dry-run prepares everything and measures startup only.
//   node bench/value-validation/discovery.mjs --out <dir> [--versions 0.3.2,0.3.3] [--runs 10] [--timeout-min 10]
//        (--dry-run | --model <model> --i-understand-this-uses-codex)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const a = process.argv.slice(2);
const arg = (n, d) => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const out = path.resolve(arg("--out", "vv-discovery"));
const versions = arg("--versions", "0.3.2,0.3.3").split(",");
const runs = Number(arg("--runs", "10"));
const timeoutMin = Number(arg("--timeout-min", "10"));
const model = arg("--model");
const dryRun = a.includes("--dry-run");
const PROMPT = "Plan, but do not implement, a page that lists orders of 50 dollars or more, newest first. Do not change any files.";
const IS_WIN = process.platform === "win32";
const sh = (cmd, args, cwd, env, input) => spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8", shell: IS_WIN, windowsHide: true, maxBuffer: 1 << 26 });
/** node itself runs without a shell (its path can hold spaces). */
const nodeRun = (args, cwd, env, input) => spawnSync(process.execPath, args, { cwd, env: env ?? process.env, input, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });

function install(v) {
  const prefix = path.join(out, "prefix-" + v);
  const bin = IS_WIN ? prefix : path.join(prefix, "bin");
  if (!fs.existsSync(path.join(bin, IS_WIN ? "duoctl.cmd" : "duoctl"))) {
    const npmrc = path.join(out, "empty.npmrc"); fs.writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
    const r = sh("npm", ["install", "-g", "--prefix", prefix, "@duo-director/cli@" + v, "--no-audit", "--no-fund", "--loglevel=error", "--userconfig", npmrc, "--cache", path.join(out, "cache-" + v)], out);
    if (r.status !== 0) throw new Error("npm install " + v + ": " + r.stderr);
  }
  const main = path.join(prefix, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli", "dist", "duoctl.js");
  return { prefix, bin, main, version: nodeRun([main, "--version"], out).stdout.trim() };
}

function repo(v, inst) {
  const root = path.join(out, "repo-" + v);
  if (fs.existsSync(path.join(root, ".git"))) return root;
  fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "services", "orders.js"), "export function listOrders(rows) {\n  return rows.filter((r) => r.total > 0);\n}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# Orders\n\nA small order service.\n");
  const git = (...g) => spawnSync("git", ["-c", "user.name=vv", "-c", "user.email=vv@example.invalid", ...g], { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "init");
  const env = { ...process.env, PATH: inst.bin + path.delimiter + process.env.PATH };
  nodeRun([inst.main, "init", "--non-interactive", "--answers", "-"], root, env, JSON.stringify([{ question: "project_goal", value: "List customer orders." }]));
  nodeRun([inst.main, "install", "codex", "--yes"], root, env);
  git("add", "-A"); git("commit", "-qm", "adopt DUO");
  nodeRun([inst.main, "index"], root, env);
  return root;
}

/** initialize time of the configured server, without Codex. */
function startup(inst, root, n = 6) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vv", version: "1" } } }) + "\n";
    const r = spawnSync(process.execPath, [inst.main, "mcp", "--root-from", "git-cwd"], { cwd: root, input: msg, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (r.stdout.includes('"id":1')) times.push(Math.round(performance.now() - t));
  }
  times.sort((p, q) => p - q);
  return { runs: times.length, medianMs: times[Math.floor(times.length / 2)] ?? null, note: "process start to initialize answer, stdin closed after the request" };
}

function session(v, inst, root, i) {
  return new Promise((resolve) => {
    const base = path.join(out, "runs", v + "-" + i);
    const args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", root, "-m", model, "-o", base + ".final.txt", "-c", 'approval_policy="never"', "-c", 'projects."' + root.replaceAll("\\", "\\\\") + '".trust_level="trusted"', "-"];
    const env = { ...process.env, PATH: inst.bin + path.delimiter + process.env.PATH };
    const t = performance.now(); let firstDuoMs = null; let buf = "";
    const p = spawn("codex", args, { cwd: root, env, shell: IS_WIN, windowsHide: true });
    const log = fs.createWriteStream(base + ".events.jsonl");
    p.stdout.on("data", (d) => { log.write(d); buf += d; if (firstDuoMs === null && /"server":"duo-director"|"tool":"duo_/u.test(buf)) firstDuoMs = Math.round(performance.now() - t); });
    p.stdin.end(PROMPT);
    const timer = setTimeout(() => p.kill(), timeoutMin * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer); log.end();
      const ev = { mcp: [], cli: 0, usage: { input: 0, cached: 0, output: 0 } };
      for (const line of buf.split(/\r?\n/u)) { let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "turn.completed" && e.usage) { ev.usage.input += e.usage.input_tokens ?? 0; ev.usage.cached += e.usage.cached_input_tokens ?? 0; ev.usage.output += e.usage.output_tokens ?? 0; }
        const it = e.item; if (e.type !== "item.completed" || it === undefined) continue;
        if (it.type === "mcp_tool_call" && (it.server === "duo-director" || /^duo_/u.test(it.tool ?? ""))) ev.mcp.push({ tool: it.tool, status: it.status, error: it.error ?? null });
        if (it.type === "command_execution" && /duoctl/u.test(it.command ?? "")) ev.cli++; }
      const first = ev.mcp[0];
      resolve({ version: v, run: i, exit: code, wallSeconds: Math.round((performance.now() - t) / 100) / 10, found: ev.mcp.length > 0, firstCallOk: first === undefined ? null : first.status === "completed" && first.error === null, firstTool: first?.tool ?? null, duoMcpCalls: ev.mcp.length, cliFallback: ev.mcp.length === 0 && ev.cli > 0, firstDuoEventMs: firstDuoMs, usage: ev.usage });
    });
  });
}

fs.mkdirSync(path.join(out, "runs"), { recursive: true });
const inst = Object.fromEntries(versions.map((v) => [v, install(v)]));
const roots = Object.fromEntries(versions.map((v) => [v, repo(v, inst[v])]));
const report = { format: "duo.value-validation-discovery/1", model: model ?? null, prompt: PROMPT, timeoutMin, versions: Object.fromEntries(versions.map((v) => [v, { duoctl: inst[v].version, startup: startup(inst[v], roots[v]) }])), sessions: [] };
console.log(JSON.stringify(report.versions));
if (!dryRun) {
  if (model === undefined || !a.includes("--i-understand-this-uses-codex")) throw new Error("real sessions need --model <model> and --i-understand-this-uses-codex (they use the runner's Codex quota)");
  for (let i = 1; i <= runs; i++) for (const v of i % 2 === 1 ? versions : [...versions].reverse()) {
    const s = await session(v, inst[v], roots[v], i); report.sessions.push(s);
    fs.writeFileSync(path.join(out, "discovery.json"), JSON.stringify(report, null, 2));
    console.log(v, i, s.found ? "found " + s.firstTool + (s.firstCallOk ? " ok" : " FAILED") : s.cliFallback ? "cli fallback" : "none", s.wallSeconds + "s");
  }
  report.summary = Object.fromEntries(versions.map((v) => { const s = report.sessions.filter((x) => x.version === v); return [v, { sessions: s.length, found: s.filter((x) => x.found).length, firstCallOk: s.filter((x) => x.firstCallOk === true).length, cliFallback: s.filter((x) => x.cliFallback).length, none: s.filter((x) => !x.found && !x.cliFallback).length }]; }));
}
fs.writeFileSync(path.join(out, "discovery.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary ?? { dryRun: true }));

