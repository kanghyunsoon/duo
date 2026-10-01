// T25.1 freshness measurement of one DUO build on one initialized, indexed repository (benchmark only; product code
// is unchanged). Plain mode times inspectIndex (no-op, warm registry) per phase over --runs runs, then a one-file edit:
// inspect (stale) and incremental index per run, reverting and re-indexing between runs. --count mode installs
// counters on Node built-ins first (git subcommands with time, lstat, cache entry reads) and runs one no-op inspect.
//   node bench/experiments/freshness-ab.mjs --duo-root <DUO checkout> --repo <indexed checkout> [--edit <path>:<kind>] [--runs 5] [--count]
import cp from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { EDITS } from "../realworld-repos.mjs";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const DUO = path.resolve(arg("duo-root"));
const root = fs.realpathSync(path.resolve(arg("repo")));
const runs = Number(arg("runs") ?? 5);
const count = process.argv.includes("--count");
const CACHE = path.join(".duo-project", "cache", "analysis");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const max = (xs) => Math.max(...xs);

const counters = new Map();
const add = (k, ms = 0) => { const c = counters.get(k) ?? { calls: 0, ms: 0 }; c.calls++; c.ms += ms; counters.set(k, c); };
if (count) {
  const isCache = (p) => typeof p === "string" && p.includes(CACHE);
  for (const f of ["lstatSync", "statSync"]) { const o = fs[f]; fs[f] = function (...a) { add("fs." + f); return o.apply(this, a); }; }
  for (const f of ["lstat", "stat"]) { const o = fs.promises[f]; fs.promises[f] = function (...a) { add("fs.promises." + f); return o.apply(this, a); }; }
  const rs = fs.readFileSync; fs.readFileSync = function (p, ...a) { if (isCache(p)) add("cache.readFileSync"); return rs.call(this, p, ...a); };
  const ra = fs.promises.readFile; fs.promises.readFile = function (p, ...a) { if (isCache(p)) add("cache.promises.readFile"); return ra.call(this, p, ...a); };
  const execFile = cp.execFile;
  cp.execFile = function (file, args, ...rest) {
    const list = Array.isArray(args) ? args.map(String) : [];
    const sub = list.find((x, i) => !x.startsWith("-") && list[i - 1] !== "-c" && list[i - 1] !== "-C") ?? "";
    const key = "git " + sub + (sub === "rev-parse" ? " " + list.slice(list.indexOf("rev-parse") + 1).join(" ") : "");
    const s = performance.now();
    const cb = rest.findIndex((x) => typeof x === "function");
    if (cb >= 0) { const f = rest[cb]; rest[cb] = (...r) => { add(key, performance.now() - s); f(...r); }; }
    return execFile.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
}
const req = createRequire(path.join(DUO, "package.json"));
const product = (n) => import(pathToFileURL(req.resolve(n)).href);
const { createDefaultAnalyzerRegistry } = await product("@duo-director/analyzer");
const { indexRepository, inspectIndex, openProjectGraphReader, openProjectGraphStore } = await product("@duo-director/graph");
const registry = (await createDefaultAnalyzerRegistry()).value;
let peakRss = 0, peakHeap = 0;
const mem = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

async function inspect() {
  const g = openProjectGraphReader(root).value;
  const phases = {};
  const t = performance.now();
  try {
    const r = await inspectIndex(root, { graph: g, registry, onPhase: (n, ms) => { phases[n] = ms; } });
    const total = performance.now() - t;
    mem();
    return { value: r.value, diagnostics: r.diagnostics, total, phases };
  } finally { g.close(); }
}
async function index() {
  const store = openProjectGraphStore(root).value;
  const t = performance.now();
  try { const r = await indexRepository(root, { store, registry }); mem(); return { mode: r.value?.mode, analyzed: r.value?.metrics?.files?.analyzed, ms: performance.now() - t }; } finally { store.close(); }
}

const out = { repo: path.basename(root), duo: path.basename(DUO), mode: count ? "count" : "plain" };
try {
  await inspect(); // warm (the long-lived MCP/UI case)
  if (count) {
    const before = new Map([...counters].map(([k, v]) => [k, { ...v }]));
    const r = await inspect();
    out.status = r.value?.status;
    out.operations = Object.fromEntries([...counters].map(([k, v]) => { const p = before.get(k) ?? { calls: 0, ms: 0 }; return [k, { calls: v.calls - p.calls, ms: Math.round(v.ms - p.ms) }]; }).filter(([, v]) => v.calls > 0).sort(([a], [b]) => (a < b ? -1 : 1)));
  } else {
    const noop = [];
    let result;
    for (let i = 0; i < runs; i++) noop.push(result = await inspect());
    out.status = result.value?.status;
    out.inspectDigest = sha(JSON.stringify({ value: result.value, diagnostics: result.diagnostics }));
    out.noop = { totalMs: { median: Math.round(median(noop.map((x) => x.total))), max: Math.round(max(noop.map((x) => x.total))) },
      phasesMs: Object.fromEntries(Object.keys(noop[0].phases).map((k) => [k, Math.round(median(noop.map((x) => x.phases[k] ?? 0)))])) };
    const e = arg("edit");
    if (e !== undefined) {
      const [rel, kind] = [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)];
      const file = path.join(root, rel);
      const original = fs.readFileSync(file);
      const text = original.toString("utf8");
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const appended = (text.endsWith("\n") ? "" : eol) + EDITS[kind].join(eol) + eol;
      const stale = [], incr = [];
      let staleStatus, mode;
      try {
        const editRuns = Number(arg("edit-runs") ?? runs);
        for (let i = 0; i < editRuns; i++) {
          fs.appendFileSync(file, appended);
          const s = await inspect(); stale.push(s.total); staleStatus = s.value?.status;
          const x = await index(); incr.push(x.ms); mode = x.mode + "/" + x.analyzed;
          fs.writeFileSync(file, original);
          await index();
        }
      } finally { fs.writeFileSync(file, original); }
      out.edit = { status: staleStatus, index: mode, staleInspectMs: Math.round(median(stale)), incrementalIndexMs: Math.round(median(incr)) };
      const back = await inspect();
      out.afterRevert = back.value?.status;
    }
  }
} finally { registry.dispose(); }
out.peakRssMB = Math.round(peakRss / 1048576);
out.peakHeapMB = Math.round(peakHeap / 1048576);
console.log(JSON.stringify(out));

