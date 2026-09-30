// T21-D benchmark-only profile of the freshness check (inspectIndex), which status, MCP, the UI, context and review
// all run before they answer. Per inspectIndex phase: wall time, file system calls and bytes read, hashing, Git
// processes and SQLite statements. The counters wrap Node built-ins inside this process only; product code is
// unchanged and results are unaffected. Async operations overlap (fingerprinting runs 16 at a time), so their
// summed ms is busy time, not wall time.
//
//   node bench/experiments/freshness-profile.mjs [large] [--runs 5] [--plain]      (needs pnpm build and the
//   benchmark fixtures in bench/results/local/fixtures, made by pnpm benchmark)
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "large";
const runsArg = process.argv.indexOf("--runs");
const runs = runsArg < 0 ? 5 : Number(process.argv[runsArg + 1]);
const plain = process.argv.includes("--plain");
// --git-args: also print every Git command line of the last run (to find duplicate queries).
const gitArgs = process.argv.includes("--git-args");
const gitLog = [];
// A fixture name, or a path to any initialized repository (T22).
const root = /[\\/]/u.test(name) ? name : fileURLToPath(new URL("../results/local/fixtures/" + name + "/", import.meta.url));

const counters = new Map();
const add = (key, ms, bytes = 0) => { const c = counters.get(key) ?? { calls: 0, ms: 0, bytes: 0 }; c.calls++; c.ms += ms; c.bytes += bytes; counters.set(key, c); };
const sizeOf = (v) => (typeof v === "string" ? Buffer.byteLength(v) : v?.byteLength ?? 0);
if (!plain) {
  const wrapSync = (obj, fn, key, bytes) => { const o = obj[fn]; if (typeof o !== "function") return; obj[fn] = function (...a) { const s = performance.now(); const r = o.apply(this, a); add(key, performance.now() - s, bytes ? sizeOf(r) : 0); return r; }; };
  const wrapAsync = (obj, fn, key, bytes) => { const o = obj[fn]; if (typeof o !== "function") return; obj[fn] = async function (...a) { const s = performance.now(); const r = await o.apply(this, a); add(key, performance.now() - s, bytes ? sizeOf(r) : 0); return r; }; };
  for (const f of ["lstatSync", "statSync", "existsSync", "readdirSync", "opendirSync", "openSync", "closeSync", "realpathSync"]) wrapSync(fs, f, "fs." + f);
  wrapSync(fs, "readFileSync", "fs.readFileSync", true);
  for (const f of ["lstat", "stat", "readdir", "opendir", "open", "realpath"]) wrapAsync(fs.promises, f, "fs.promises." + f);
  wrapAsync(fs.promises, "readFile", "fs.promises.readFile", true);
  const createHash = crypto.createHash;
  crypto.createHash = function (alg, o) {
    const h = createHash.call(this, alg, o); const update = h.update.bind(h);
    add("crypto.createHash(" + alg + ")", 0);
    h.update = (d, e) => { const s = performance.now(); update(d, e); add("crypto.update(" + alg + ")", performance.now() - s, sizeOf(d)); return h; };
    return h;
  };
  const execFile = cp.execFile;
  cp.execFile = function (file, args, ...rest) {
    // The Git subcommand: the first argument that is neither an option nor the value of -c / -C.
    const list = Array.isArray(args) ? args.map(String) : [];
    const sub = list.find((x, i) => !x.startsWith("-") && list[i - 1] !== "-c" && list[i - 1] !== "-C") ?? "";
    const s = performance.now(); const key = "git " + sub;
    if (gitArgs) gitLog.push(list.join(" "));
    const cbIndex = rest.findIndex((x) => typeof x === "function");
    if (cbIndex >= 0) { const cb = rest[cbIndex]; rest[cbIndex] = (...r) => { add(String(file).includes("git") ? key : "execFile " + file, performance.now() - s); cb(...r); }; }
    return execFile.call(this, file, args, ...rest);
  };
  const wrapProto = (proto, fn, key) => { const o = proto[fn]; if (typeof o !== "function") return; proto[fn] = function (...a) { const s = performance.now(); const r = o.apply(this, a); add(key, performance.now() - s); return r; }; };
  wrapProto(sqlite.DatabaseSync.prototype, "prepare", "sqlite.prepare");
  wrapProto(sqlite.DatabaseSync.prototype, "exec", "sqlite.exec");
  for (const f of ["all", "get", "run", "iterate"]) wrapProto(sqlite.StatementSync.prototype, f, "sqlite." + f);
  syncBuiltinESMExports();
}

const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { inspectIndex, openProjectGraphReader } = await import("@duo-director/graph");
const registry = (await createDefaultAnalyzerRegistry()).value;
const snapshot = () => new Map([...counters].map(([k, v]) => [k, { ...v }]));
const delta = (a, b) => Object.fromEntries([...b].map(([k, v]) => { const p = a.get(k) ?? { calls: 0, ms: 0, bytes: 0 }; return [k, { calls: v.calls - p.calls, ms: Math.round(v.ms - p.ms), bytes: v.bytes - p.bytes }]; }).filter(([, v]) => v.calls > 0).sort((x, y) => y[1].ms - x[1].ms));

async function inspectOnce() {
  const phases = [];
  let last = snapshot();
  const started = performance.now();
  const graph = openProjectGraphReader(root).value;
  const opened = snapshot();
  phases.push({ name: "open-graph", ms: 0, ops: delta(last, opened) });
  last = opened;
  const r = await inspectIndex(root, { graph, registry, onPhase: (phase, ms) => { const now = snapshot(); phases.push({ name: phase, ms: Math.round(ms), ops: delta(last, now) }); last = now; } });
  graph.close();
  return { status: r.value?.status, files: r.value?.coverage.files, totalMs: Math.round(performance.now() - started), phases };
}

await inspectOnce(); // warm: the long-lived MCP/UI case
const samples = [];
for (let i = 0; i < runs; i++) { gitLog.length = 0; samples.push(await inspectOnce()); }
registry.dispose();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const phaseNames = samples[0].phases.map((p) => p.name);
console.log(JSON.stringify({
  fixture: name, runs, instrumented: !plain, node: process.version, platform: process.platform, status: samples[0].status, files: samples[0].files,
  totalMs: { median: median(samples.map((s) => s.totalMs)), min: Math.min(...samples.map((s) => s.totalMs)), max: Math.max(...samples.map((s) => s.totalMs)) },
  phases: phaseNames.map((n) => ({ name: n, medianMs: median(samples.map((s) => s.phases.find((p) => p.name === n)?.ms ?? 0)), ops: plain ? undefined : samples.at(-1).phases.find((p) => p.name === n)?.ops })),
  ...(gitArgs ? { gitCommands: gitLog } : {}),
}, null, 1));

