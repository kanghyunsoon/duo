// T22-B/D benchmark-only: one repository per process (so RSS is its own). Counters wrap Node built-ins in this
// process only; product code is unchanged.
//   node bench/experiments/realworld.mjs --repo <dir> --task "<text>" --expect a,b,c --edit <repo path>
// Needs a Git working tree with at least one commit and pnpm build. Writes .duo-project inside <dir>.
import cp, { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(arg("repo"));
const task = arg("task");
const expected = (arg("expect") ?? "").split(",").filter(Boolean);
const editPath = arg("edit");
const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));

const counters = new Map();
const add = (k) => counters.set(k, (counters.get(k) ?? 0) + 1);
for (const f of ["lstatSync", "statSync", "readFileSync", "openSync", "readdirSync"]) { const o = fs[f]; fs[f] = function (...a) { add("fs." + f); return o.apply(this, a); }; }
for (const f of ["lstat", "stat", "readFile", "open", "readdir"]) { const o = fs.promises[f]; fs.promises[f] = function (...a) { add("fs.promises." + f); return o.apply(this, a); }; }
const execFile = cp.execFile;
cp.execFile = function (file, ...rest) { add(String(file).toLowerCase().includes("git") ? "git" : "execFile"); return execFile.call(this, file, ...rest); };
syncBuiltinESMExports();
const snap = () => new Map(counters);
const diff = (a) => { const o = {}; for (const [k, v] of counters) { const d = v - (a.get(k) ?? 0); if (d > 0) o[k] = d; } return o; };
let peakRss = 0, peakHeap = 0;
const mem = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
const ms = (s) => Math.round(performance.now() - s);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// init through the CLI (a cold process, as a user runs it): Truth, first index, adoption baseline
fs.rmSync(path.join(root, ".duo-project"), { recursive: true, force: true });
let s = performance.now();
const init = spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const initMs = ms(s);
const initJson = JSON.parse(init.stdout || "{}");

s = performance.now();
const { createDefaultAnalyzerRegistry, scanRepository } = await import("@duo-director/analyzer");
const { loadProjectTruth } = await import("@duo-director/core");
const { indexRepository, inspectIndex, openProjectGraphReader, openProjectGraphStore } = await import("@duo-director/graph");
const { projectContext, projectReview } = await import("@duo-director/integration");
const importMs = ms(s);
s = performance.now();
const registry = (await createDefaultAnalyzerRegistry()).value;
const grammarMs = ms(s);
const truth = loadProjectTruth(root).value.truth;
const scan = await scanRepository(root, { include: truth.config.index.include, exclude: truth.config.index.exclude });
const excluded = {};
for (const e of scan.excluded) excluded[e.reason] = (excluded[e.reason] ?? 0) + 1;
const bytes = scan.files.reduce((n, f) => { try { return n + fs.statSync(path.join(root, f.path)).size; } catch { return n; } }, 0);

// initial index in this process: regenerable state removed first (graph, state, caches)
for (const d of ["generated", "cache"]) fs.rmSync(path.join(root, ".duo-project", d), { recursive: true, force: true });
let store = openProjectGraphStore(root).value;
s = performance.now();
const initial = await indexRepository(root, { store, registry });
const initialMs = ms(s); store.close(); mem();

const inspect = async () => { const g = openProjectGraphReader(root).value; try { return await inspectIndex(root, { graph: g, registry }); } finally { g.close(); } };
await inspect();
const noop = [];
let noopOps, status, coverage;
for (let i = 0; i < 3; i++) { const before = snap(); s = performance.now(); const r = await inspect(); noop.push(ms(s)); noopOps = diff(before); status = r.value?.status; coverage = r.value?.coverage.files; }
mem();

let incremental = null;
if (editPath !== undefined) {
  fs.appendFileSync(path.join(root, editPath), "\n// t22 edit\n");
  store = openProjectGraphStore(root).value;
  s = performance.now();
  const r = await indexRepository(root, { store, registry });
  incremental = { ms: ms(s), parsed: r.value?.metrics?.files?.analyzed ?? r.value?.metrics?.analyzed ?? null, mode: r.value?.mode };
  store.close(); mem();
}

const contexts = [];
let packet;
for (let i = 0; i < 2; i++) { s = performance.now(); const c = await projectContext(root, { task }, { registry }); contexts.push(ms(s)); packet = c?.context?.packet ?? c?.payload?.context?.packet ?? c?.value?.context?.packet; }
mem();
const items = packet === undefined ? [] : [...packet.code, ...packet.tests];
const files = [...new Set(items.map((x) => x.source?.path).filter(Boolean))];
const found = expected.filter((e) => files.some((f) => f.endsWith(e)));
s = performance.now();
const rv = await projectReview(root, { task, diff: { from: "HEAD", to: "WORKTREE" } }, { registry });
const reviewMs = ms(s); mem();
const review = rv?.review ?? rv?.payload ?? rv;
registry.dispose();

console.log(JSON.stringify({
  repo: path.basename(root), node: process.version, platform: process.platform,
  files: { indexed: scan.files.length, bytes, structural: coverage?.structural, fileOnly: coverage?.fileOnly, excluded },
  init: { cliMs: initMs, exit: init.status, baseline: initJson?.result?.baseline?.status ?? null },
  importMs, grammarMs,
  initialIndex: { ms: initialMs, ok: initial.value !== undefined },
  noopFreshness: { medianMs: median(noop), runs: noop, status, ops: noopOps },
  incremental,
  context: { medianMs: median(contexts), status: packet === undefined ? "no packet" : "ready", codeAndTests: items.length, files: files.length, expected, found, missing: expected.filter((e) => !found.includes(e)), omitted: packet?.omittedCandidates?.length ?? null, truncated: packet?.truncated ?? null, usedTokens: packet?.budget?.used ?? null, limitations: [...new Set((packet?.limitations ?? []).map((l) => l.code))] },
  review: { ms: reviewMs, verdict: review?.verdict ?? review?.result?.verdict ?? null },
  memory: { peakRssMB: Math.round(peakRss / 1048576), peakHeapMB: Math.round(peakHeap / 1048576) },
}, null, 1));

