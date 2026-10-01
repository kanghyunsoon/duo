// T25.1 concurrency of the analysis-cache check on one indexed repository: the production primitive
// (cachedAnalysesValid) at several limits against the pre-T25.1 sequential check (readRegenerable + the same entry
// check), interleaved per round. Per variant: median and worst wall time, peak RSS / heap growth, peak in-flight
// file requests (process.getActiveResourcesInfo), and whether the answers equal the sequential ones.
//   node bench/experiments/cache-verify-concurrency.mjs --repo <indexed checkout> [--rounds 7] [--limits 4,8,16,32]
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = fs.realpathSync(path.resolve(arg("repo")));
const rounds = Number(arg("rounds") ?? 7);
const limits = (arg("limits") ?? "4,8,16,32").split(",").map(Number);
const dist = (p) => import(pathToFileURL(fileURLToPath(new URL("../../packages/graph/dist/incremental/" + p, import.meta.url))).href);
// Counts file requests in flight: every fs.promises lstat/readFile is wrapped (the primitive calls them at run time).
let live = 0, liveMax = 0;
for (const name of ["lstat", "readFile"]) {
  const original = fs.promises[name];
  fs.promises[name] = async (...a) => { live++; liveMax = Math.max(liveMax, live); try { return await original(...a); } finally { live--; } };
}
const { ANALYSIS_CACHE_DIR, analysisCacheFileName, cachedAnalysesValid, parseCachedAnalysis } = await dist("analysis-cache.js");
const { readRegenerable } = await dist("files.js");
const { readIndexState } = await dist("state.js");
const state = readIndexState(root).state;
const keys = state.files.filter((f) => f.analysis !== undefined).map((f) => ({ path: f.path, contentHash: f.contentHash, analyzer: f.analysis.analyzer, analyzerIdentity: f.analysis.identity }));
const sequential = async () => keys.map((k) => { const r = readRegenerable(root, ANALYSIS_CACHE_DIR + "/" + analysisCacheFileName(k)); return r.text !== undefined && parseCachedAnalysis(r.text, k) !== undefined; });
const variants = [["sequential", sequential], ...limits.map((c) => ["limit " + c, () => cachedAnalysesValid(root, keys, c)])];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = new Map(variants.map(([n]) => [n, { ms: [], rss: 0, heap: 0, inFlight: 0, equal: true }]));
const reference = await sequential();
for (let r = 0; r < rounds; r++) {
  for (const [name, fn] of (r % 2 === 0 ? variants : [...variants].reverse())) {
    globalThis.gc?.();
    const s = stats.get(name);
    const m0 = process.memoryUsage();
    let peakRss = m0.rss, peakHeap = m0.heapUsed;
    liveMax = 0;
    const timer = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 1);
    const t = performance.now();
    const out = await fn();
    const ms = performance.now() - t;
    clearInterval(timer);
    const m1 = process.memoryUsage();
    s.ms.push(ms);
    s.rss = Math.max(s.rss, Math.max(peakRss, m1.rss) - m0.rss);
    s.heap = Math.max(s.heap, Math.max(peakHeap, m1.heapUsed) - m0.heapUsed);
    s.inFlight = Math.max(s.inFlight, liveMax);
    if (JSON.stringify(out) !== JSON.stringify(reference)) s.equal = false;
  }
}
await new Promise((r) => setImmediate(r));
const leftover = live + process.getActiveResourcesInfo().filter((x) => x === "FSReqCallback" || x === "FileHandle" || x === "FSReqPromise").length;
console.log(JSON.stringify({ repo: path.basename(root), entries: keys.length, valid: reference.filter(Boolean).length, rounds, platform: process.platform, fileRequestsAfter: leftover,
  variants: [...stats].map(([name, s]) => ({ name, medianMs: Math.round(median(s.ms)), worstMs: Math.round(Math.max(...s.ms)), rssGrowthMB: Math.round(s.rss / 1048576), heapGrowthMB: Math.round(s.heap / 1048576), peakInFlight: s.inFlight, equal: s.equal })) }));

