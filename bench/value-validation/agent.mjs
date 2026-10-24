#!/usr/bin/env node
// Value Validation 01 (T81): the agent-run harness for conditions A, B and C.
//
// Every run starts from a fresh copy of the condition's template repository (fixture.mjs), gets the same task prompt
// (tasks.mjs) through `codex exec --json` with a pinned model, the same sandbox and the same time limit, and is
// measured afterwards: wall time, tokens reported by Codex (turn.completed usage), commands, check runs, rework cycles,
// MCP calls, DUO Context Packet tokens (condition C metrics.jsonl), the independent oracle (oracle.mjs), and the hidden
// acceptance test. The order of tasks and conditions is randomized with a seed and balanced over the six orders of A/B/C.
// It uses the Codex login of the person who runs it (no credential is copied) and costs Codex usage, so it never runs
// without --model and --i-understand-this-uses-codex; --dry-run builds everything and prints the commands instead.
//
//   node bench/value-validation/agent.mjs --out <dir> --duoctl <duoctl.js> --duoctl-bin <dir with duoctl on PATH> --core <core dist index.js>
//        [--tasks T1,T2] [--conditions A,B,C] [--reps 3] [--seed 81] [--timeout-min 20]
//        (--dry-run | --selftest | --model <model> --i-understand-this-uses-codex)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CASES } from "./cases.mjs";
import { generate, git } from "./fixture.mjs";
import { readEvents, sumAll } from "./measure.mjs";
import { judge } from "./oracle.mjs";
import { installSignalCleanup, startProcess } from "./process.mjs";
import { TASKS } from "./tasks.mjs";

const a = process.argv.slice(2);
const arg = (n, d) => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const flag = (n) => a.includes(n);
const out = path.resolve(arg("--out", "vv-agent"));
const opts = {
  duoctl: arg("--duoctl") && path.resolve(arg("--duoctl")), duoctlBin: arg("--duoctl-bin") && path.resolve(arg("--duoctl-bin")), core: arg("--core") && path.resolve(arg("--core")),
  tasks: arg("--tasks", TASKS.map((t) => t.id).join(",")).split(","), conditions: arg("--conditions", "A,B,C").split(","), reps: Number(arg("--reps", "3")),
  seed: Number(arg("--seed", "81")), timeoutMin: Number(arg("--timeout-min", "20")), model: arg("--model"), codex: arg("--codex", "codex"),
  dryRun: flag("--dry-run"), selftest: flag("--selftest"),
};

/** Seeded PRNG (mulberry32) so a schedule can be reproduced and published before the runs. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ORDERS = [["A", "B", "C"], ["A", "C", "B"], ["B", "A", "C"], ["B", "C", "A"], ["C", "A", "B"], ["C", "B", "A"]];
export function schedule({ tasks, conditions, reps, seed }) {
  const r = rng(seed); const runs = []; let k = Math.floor(r() * 6);
  for (let rep = 1; rep <= reps; rep++) {
    const order = [...tasks]; for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const task of order) { for (const c of ORDERS[k % 6].filter((x) => conditions.includes(x))) runs.push({ id: task + "-" + c + "-r" + rep, task, condition: c, rep }); k++; }
  }
  return runs;
}

const sh = (cmd, args, cwd, env) => spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 1 << 28 });

/** Templates with their timed setup (condition C also installs DUO's Codex integration). B and C install ESLint once. */
async function templates() {
  const dir = path.join(out, "templates"); const info = {};
  for (const c of opts.conditions) {
    const root = path.join(dir, c);
    if (fs.existsSync(path.join(root, ".git"))) { info[c] = JSON.parse(fs.readFileSync(path.join(dir, c + ".json"), "utf8")); continue; }
    const g = await generate(root, c, { duoctl: opts.duoctl, core: opts.core });
    if (c !== "A") {
      const t = performance.now(); const r = sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], root); if (r.status !== 0) throw new Error("npm install " + c + ": " + r.stderr); g.setup.push({ step: "npm install (ESLint)", ms: Math.round(performance.now() - t) });
      git(root, "add", "-A"); git(root, "commit", "--no-verify", "-qm", "Lock the check dependencies");
      if (c === "C") { const ti = performance.now(); spawnSync(process.execPath, [opts.duoctl, "index"], { cwd: root, windowsHide: true }); g.setup.push({ step: "duoctl index", ms: Math.round(performance.now() - ti) }); }
      g.adoption = git(root, "rev-parse", "HEAD").trim();
    }
    info[c] = g; fs.writeFileSync(path.join(dir, c + ".json"), JSON.stringify(g, null, 2));
  }
  return info;
}

/** Codex event parsing lives in measure.mjs (pure, unit-tested); re-exported for existing callers. */
export { readEvents };

// Issue #66: Codex runs without a shell-joined command line, and a timeout stops its whole process tree (process.mjs).
// The timeout is the timer's own flag; stderr text is never read back to decide it.
function runCodex(repo, prompt, files, env) {
  const args = ["exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-C", repo, "-m", opts.model, "-o", files.final, "-c", 'approval_policy="never"', "-c", 'projects."' + repo.replaceAll("\\", "\\\\") + '".trust_level="trusted"', "-"];
  const { child, result } = startProcess(opts.codex, args, { cwd: repo, env, input: prompt, timeoutMs: opts.timeoutMin * 60_000 });
  const log = fs.createWriteStream(files.events);
  let logError;
  log.on("error", (error) => { logError ??= error; });
  child.stdout.pipe(log); child.stderr.on("data", (d) => fs.appendFileSync(files.stderr, d));
  return result.then((p) => new Promise((resolve) => {
      const wallSeconds = Math.round(p.wallMs / 100) / 10;
      // Resolve only after the event log has flushed (finish) or failed (error), so the last turn.completed is not lost.
      let settled = false;
      const done = () => {
        if (settled) return; settled = true;
        resolve({
          exit: p.exit, wallSeconds, timedOut: p.timedOut, ...(p.timedOut ? { terminated: p.terminated, killAttempts: p.killAttempts, pid: p.pid } : {}),
          ...(p.spawnError === undefined ? {} : { spawnError: p.spawnError }), ...(logError === undefined ? {} : { logError: String(logError.message ?? logError) }),
        });
      };
      if (logError !== undefined || log.writableFinished) return done();
      log.once("finish", done);
      log.once("error", (error) => { logError ??= error; done(); });
      log.end();
  }));
}

function acceptance(repo, task) {
  if (task.acceptance === null) return null;
  const f = path.join(repo, "test", "_acceptance_" + task.id + ".test.js");
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, task.acceptance);
  const r = spawnSync(process.execPath, ["--test", f], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  fs.rmSync(f);
  return { ok: r.status === 0, output: (r.stdout + r.stderr).slice(-600) };
}

function contextTokens(repo) {
  const f = path.join(repo, ".duo-project", "runtime", "metrics.jsonl");
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").split(/\r?\n/u).flatMap((l) => { try { const m = JSON.parse(l); return typeof m.contextTokens === "number" ? [m.contextTokens] : []; } catch { return []; } }).reduce((p, q) => p + q, 0);
}

/** The protocol's duo_version: condition C uses this public package in both places DUO runs (templates and the agent's PATH). */
const DUO_VERSION = "0.3.3";
function checkDuoctl(env) {
  const v = (r) => (r.status === 0 ? String(r.stdout).trim() : "failed: " + String(r.stderr || r.error?.message || "").trim().split("\n")[0]);
  const script = opts.duoctl === undefined ? "missing --duoctl" : v(spawnSync(process.execPath, [opts.duoctl, "--version"], { encoding: "utf8", windowsHide: true }));
  const onPath = v(spawnSync("duoctl", ["--version"], { env, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" }));
  const want = "duoctl " + DUO_VERSION;
  if (script !== want || onPath !== want) throw new Error("condition C needs @duo-director/cli@" + DUO_VERSION + ": --duoctl reports \"" + script + "\", duoctl on the agent's PATH reports \"" + onPath + "\"");
  return { script, onPath };
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  if (opts.selftest) return selftest();
  if (!opts.dryRun && (opts.model === undefined || !flag("--i-understand-this-uses-codex"))) throw new Error("real runs need --model <model> and --i-understand-this-uses-codex (they use the runner's Codex quota); use --dry-run to check the setup");
  if (!opts.dryRun) installSignalCleanup();
  const env = { ...process.env, PATH: (opts.duoctlBin ? opts.duoctlBin + path.delimiter : "") + process.env.PATH };
  const duoctl = opts.conditions.includes("C") ? checkDuoctl(env) : null;
  const info = await templates();
  const plan = schedule(opts);
  fs.writeFileSync(path.join(out, "schedule.json"), JSON.stringify({ seed: opts.seed, model: opts.model ?? null, timeoutMin: opts.timeoutMin, duoctl, runs: plan }, null, 2));
  const resultsFile = path.join(out, "runs.json");
  const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : { format: "duo.value-validation-agents/1", templates: info, runs: [] };
  const done = new Set(results.runs.map((r) => r.id));
  for (const run of plan) {
    if (done.has(run.id)) continue;
    const task = TASKS.find((t) => t.id === run.task);
    const dir = path.join(out, "runs", run.id); const repo = path.join(dir, "repo");
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(out, "templates", run.condition), repo, { recursive: true });
    const adoption = info[run.condition].adoption;
    const sessions = [task.prompt, ...(task.handoff === undefined ? [] : [task.handoff])];
    const record = { ...run, model: opts.model ?? null, startedAt: new Date().toISOString(), sessions: [] };
    for (const [i, prompt] of sessions.entries()) {
      const files = { events: path.join(dir, "session-" + (i + 1) + ".events.jsonl"), final: path.join(dir, "session-" + (i + 1) + ".final.txt"), stderr: path.join(dir, "session-" + (i + 1) + ".stderr.txt") };
      fs.writeFileSync(path.join(dir, "session-" + (i + 1) + ".prompt.txt"), prompt);
      if (opts.dryRun) { record.sessions.push({ dryRun: true, command: [opts.codex, "exec", "--json", "-s", "workspace-write", "-C", repo, "-m", "<model>", "-"].join(" ") }); continue; }
      const r = await runCodex(repo, prompt, files, env);
      record.sessions.push({ ...r, events: readEvents(files.events) });
      if (r.timedOut && r.terminated !== true) {
        // The session may still be running: record it and stop, so no later run overlaps it or shares its quota.
        Object.assign(record, { status: "kill-failed", wallSeconds: null, usage: null });
        results.runs.push(record); fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        throw new Error(run.id + " session " + (i + 1) + " did not stop after the " + opts.timeoutMin + "-minute timeout (root PID " + r.pid + "); stopped before the next run. End that process tree, then resume.");
      }
    }
    const evs = record.sessions.map((s) => s.events).filter((e) => e !== undefined);
    // A session without usage (or a session whose event log could not be written) makes the run's token totals NOT MEASURED.
    const sum = (k) => (evs.length !== record.sessions.length || record.sessions.some((s) => s.logError !== undefined) ? null : sumAll(evs.map((e) => e.usage?.[k])));
    Object.assign(record, {
      status: opts.dryRun ? "dry-run" : record.sessions.some((s) => s.timedOut) ? "timeout" : record.sessions.every((s) => s.exit === 0) ? "completed" : "failed",
      wallSeconds: opts.dryRun ? null : record.sessions.reduce((p, s) => p + s.wallSeconds, 0),
      usage: opts.dryRun ? null : { input: sum("input"), cached: sum("cached"), output: sum("output") },
      events: opts.dryRun ? null : { checkRuns: evs.reduce((p, e) => p + e.checkRuns, 0), failedChecks: evs.reduce((p, e) => p + e.failedChecks, 0), reworkCycles: evs.reduce((p, e) => p + e.reworkCycles, 0), proposals: evs.reduce((p, e) => p + e.proposals, 0), duoMcpCalls: evs.reduce((p, e) => p + e.mcp.filter((m) => m.server === "duo-director" || /^duo_/u.test(m.tool ?? "")).length, 0), duoctlCommands: evs.reduce((p, e) => p + e.commands.filter((c) => /duoctl/u.test(c.command)).length, 0) },
      oracle: judge(repo, adoption), tests: acceptance(repo, task), duo: { contextTokens: run.condition === "C" ? contextTokens(repo) : null },
      diff: execFileSync("git", ["diff", "--shortstat", adoption], { cwd: repo, encoding: "utf8" }).trim(),
      humanReview: task.category === 4 || judge(repo, adoption).needsReview ? "required" : "not-required",
    });
    record.oracle.askedHuman = task.category === 4 ? null : undefined; // set by the person who reads the final message
    results.runs.push(record);
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    console.log(run.id, record.status, record.wallSeconds ?? "-", "s · violations", record.oracle.violations, "· tests", record.tests === null ? "n/a" : record.tests.ok);
  }
}

/** Checks the oracle against the deterministic ground truth (cases.mjs) on a condition A repository. */
async function selftest() {
  const root = path.join(out, "selftest-template");
  if (!fs.existsSync(path.join(root, ".git"))) await generate(root, "A");
  const adoption = git(root, "rev-parse", "HEAD").trim();
  const rows = [];
  for (const c of CASES) {
    const repo = path.join(out, "selftest", c.id); fs.rmSync(repo, { recursive: true, force: true }); fs.cpSync(root, repo, { recursive: true });
    for (const [p, t] of Object.entries(c.write ?? {})) { const f = path.join(repo, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); }
    for (const [p, { find, by }] of Object.entries(c.edit ?? {})) { const f = path.join(repo, p); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(find, by)); }
    if (c.pkg !== undefined) { const f = path.join(repo, "package.json"); const j = JSON.parse(fs.readFileSync(f, "utf8")); for (const [k, v] of Object.entries(c.pkg)) j[k] = { ...(j[k] ?? {}), ...v }; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); }
    const j = judge(repo, adoption, { approved: c.approval === true ? ["R2"] : [] });
    const verdict = j.violations > 0 ? "violation" : j.needsReview ? "needs-review" : "compliant";
    rows.push({ id: c.id, truth: c.truth, oracle: verdict, agrees: verdict === c.truth || (verdict === "needs-review" && c.truth === "violation"), added: j.added, review: j.review });
  }
  for (const r of rows) console.log(r.id.padEnd(3), r.truth.padEnd(10), r.oracle.padEnd(13), r.agrees ? "ok" : "DISAGREES", r.added.join("; "), r.review.join("; "));
  fs.writeFileSync(path.join(out, "oracle-selftest.json"), JSON.stringify(rows, null, 2));
  if (rows.some((r) => !r.agrees)) process.exitCode = 1;
}

await main();
