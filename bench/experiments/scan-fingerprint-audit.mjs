// T25.2 scan / fingerprint cost audit of one indexed repository (benchmark only; product code is not changed).
//   node bench/experiments/scan-fingerprint-audit.mjs --repo <indexed checkout> [--duo-root <DUO checkout>] [--runs 5]
//        [--mode phases|count|decompose] [--limits 1,2,4,8,16,32]
// phases:    inspectIndex (warm registry, one warm-up) per phase over --runs runs, plus peak RSS / heap.
// count:     one warm no-op inspectIndex with counters on node:fs, node:crypto and child_process: calls per kind,
//            the same path touched more than once per kind (with the calling functions), bytes read and hashed,
//            Git subcommands with time. Counting is installed before the product modules are loaded.
// decompose: the scan split into Git queries, lstat, path policy, build-output matching, path normalization and the
//            rest; the fingerprint split per file into lstat, read, CRLF canonicalization and SHA-256 (sequential,
//            warm), aggregated by file category, size bucket, fingerprint mode and analysis level; hashing bytes
//            already in memory; a Buffer.indexOf canonicalization (checked byte-identical); and the production
//            fingerprint at several concurrency limits, interleaved per round, with RSS / heap and equality.
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const DUO = path.resolve(arg("duo-root") ?? fileURLToPath(new URL("../..", import.meta.url)));
const root = fs.realpathSync(path.resolve(arg("repo")));
const runs = Number(arg("runs") ?? 5);
const mode = arg("mode") ?? "phases";
const limits = (arg("limits") ?? "1,2,4,8,16,32").split(",").map(Number);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

// ---- counters (count mode only; installed before the product is imported) ----
const ops = new Map(); // kind -> { calls, ms, bytes }
const perPath = new Map(); // kind -> Map(path -> { n, callers:Set })
let counting = false;
const rel = (p) => { if (typeof p !== "string") return undefined; const r = path.relative(root, p).split(path.sep).join("/"); return r.startsWith("..") ? undefined : r; };
const callerOf = () => {
  const frames = (new Error().stack ?? "").split("\n").slice(3);
  const own = frames.find((f) => /[\\/]dist[\\/]/u.test(f) && !/scan-fingerprint-audit/u.test(f));
  const m = own?.match(/at (?:async )?([\w.<>$]+)?\s*\(?.*[\\/](packages[\\/][^:)]+)/u);
  return m === null || m === undefined ? "?" : (m[1] ?? "<anon>") + " " + m[2].split(path.sep).join("/").replace(/^packages\/(\w+)\/dist\//u, "$1:");
};
const note = (kind, p, ms = 0, bytes = 0) => {
  if (!counting) return;
  const o = ops.get(kind) ?? { calls: 0, ms: 0, bytes: 0 }; o.calls++; o.ms += ms; o.bytes += bytes; ops.set(kind, o);
  const r = rel(p); if (r === undefined) return;
  let m = perPath.get(kind); if (m === undefined) perPath.set(kind, (m = new Map()));
  const e = m.get(r) ?? { n: 0, callers: new Set() }; e.n++; e.callers.add(callerOf()); m.set(r, e);
};
const sizeOf = (v) => (typeof v === "string" ? Buffer.byteLength(v) : v?.length ?? 0);
if (mode === "count") {
  for (const f of ["lstatSync", "statSync", "existsSync", "readlinkSync", "realpathSync", "openSync", "readdirSync"]) {
    const o = fs[f]; fs[f] = function (p, ...a) { const t = performance.now(); try { return o.call(this, p, ...a); } finally { note("fs." + f, p, performance.now() - t); } };
  }
  const rfs = fs.readFileSync; fs.readFileSync = function (p, ...a) { const t = performance.now(); const v = rfs.call(this, p, ...a); note("fs.readFileSync", p, performance.now() - t, sizeOf(v)); return v; };
  for (const f of ["lstat", "stat", "readlink", "realpath", "open", "readdir"]) {
    const o = fs.promises[f]; fs.promises[f] = async function (p, ...a) { note("fs.promises." + f, p); return o.call(this, p, ...a); };
  }
  const rfa = fs.promises.readFile; fs.promises.readFile = async function (p, ...a) { const v = await rfa.call(this, p, ...a); note("fs.promises.readFile", p, 0, sizeOf(v)); return v; };
  const ch = crypto.createHash;
  crypto.createHash = function (alg, ...a) {
    const h = ch.call(this, alg, ...a); if (!counting) return h;
    const caller = callerOf(); const up = h.update.bind(h); let bytes = 0;
    h.update = (d, ...x) => { bytes += sizeOf(d); return up(d, ...x); };
    const dg = h.digest.bind(h); h.digest = (...x) => { note("crypto.hash " + caller, undefined, 0, bytes); return dg(...x); };
    return h;
  };
  const execFile = cp.execFile;
  cp.execFile = function (file, args, ...rest) {
    const list = Array.isArray(args) ? args.map(String) : [];
    const sub = list.find((x, i) => !x.startsWith("-") && list[i - 1] !== "-c" && list[i - 1] !== "-C") ?? "";
    const key = "git " + sub + (sub === "rev-parse" || sub === "ls-files" ? " " + list.slice(list.indexOf(sub) + 1).filter((x) => x !== "-z").join(" ") : "");
    const s = performance.now(); const cb = rest.findIndex((x) => typeof x === "function");
    if (cb >= 0) { const f = rest[cb]; rest[cb] = (...r) => { note(key, undefined, performance.now() - s); f(...r); }; }
    return execFile.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
}

const req = createRequire(path.join(DUO, "package.json"));
const product = (n) => import(pathToFileURL(req.resolve(n)).href);
const dist = (pkg, p) => import(pathToFileURL(path.join(DUO, "packages", pkg, "dist", p)).href);
const analyzer = await product("@duo-director/analyzer");
const { inspectIndex, openProjectGraphReader } = await product("@duo-director/graph");
const core = await product("@duo-director/core");
const registry = (await analyzer.createDefaultAnalyzerRegistry()).value;
let peakRss = 0, peakHeap = 0;
const mem = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
async function inspect() {
  const g = openProjectGraphReader(root).value; const phases = {}; const t = performance.now();
  try { const r = await inspectIndex(root, { graph: g, registry, onPhase: (n, ms) => { phases[n] = ms; } }); mem(); return { status: r.value?.status, total: performance.now() - t, phases, coverage: r.value?.coverage }; }
  finally { g.close(); }
}
const out = { repo: path.basename(root), duo: path.basename(DUO), mode, node: process.version, platform: process.platform };
try {
  if (mode === "phases") {
    await inspect();
    const xs = []; for (let i = 0; i < runs; i++) xs.push(await inspect());
    out.status = xs.at(-1).status;
    out.totalMs = { median: Math.round(median(xs.map((x) => x.total))), runs: xs.map((x) => Math.round(x.total)) };
    out.phasesMs = Object.fromEntries(Object.keys(xs[0].phases).map((k) => [k, Math.round(median(xs.map((x) => x.phases[k] ?? 0)))]));
    const c = xs.at(-1).coverage?.files; out.coverage = c;
  } else if (mode === "count") {
    await inspect();
    counting = true; const r = await inspect(); counting = false;
    out.status = r.status;
    out.ops = Object.fromEntries([...ops].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, { calls: v.calls, ms: Math.round(v.ms), ...(v.bytes > 0 ? { bytes: v.bytes } : {}) }]));
    out.repeatedPaths = Object.fromEntries([...perPath].map(([kind, m]) => {
      const rep = [...m].filter(([, e]) => e.n > 1);
      const byCallers = new Map();
      for (const [, e] of rep) { const k = [...e.callers].sort().join(" + ") + " (x" + e.n + ")"; byCallers.set(k, (byCallers.get(k) ?? 0) + 1); }
      return [kind, { distinctPaths: m.size, pathsTouchedMoreThanOnce: rep.length, groups: Object.fromEntries([...byCallers].sort((a, b) => b[1] - a[1]).slice(0, 8)) }];
    }));
    // the same path across kinds: lstat (scan) + lstat (fingerprint) + read
    const kindsOf = new Map();
    for (const [kind, m] of perPath) for (const [p, e] of m) { const k = kindsOf.get(p) ?? {}; k[kind] = e.n; kindsOf.set(p, k); }
    const patterns = new Map();
    for (const k of kindsOf.values()) { const s = Object.entries(k).sort().map(([a, n]) => a + "x" + n).join(" "); patterns.set(s, (patterns.get(s) ?? 0) + 1); }
    out.perPathPatterns = Object.fromEntries([...patterns].sort((a, b) => b[1] - a[1]).slice(0, 10));
  } else if (mode === "decompose") {
    const { loadProjectTruth } = core;
    const truth = loadProjectTruth(root).value.truth;
    const opts = { include: truth.config.index.include, exclude: truth.config.index.exclude };
    const gi = await dist("analyzer", "scan/git-index.js");
    const { createPathPolicy } = await dist("analyzer", "scan/policy.js");
    const { buildOutputMatcher } = await dist("analyzer", "scan/build-output.js");
    const { canonicalContent, computeContentHash } = await dist("analyzer", "fingerprint/content-hash.js");
    const { fingerprintModeOf } = await dist("analyzer", "fingerprint/fingerprint-mode.js");
    const time = async (fn) => { const t = performance.now(); const v = await fn(); return [performance.now() - t, v]; };
    // warm-up (file cache, JIT)
    const warmScan = await analyzer.scanRepository(root, opts);
    await analyzer.fingerprintRepositoryFiles(root, warmScan.files);
    // ---- scan split ----
    const scanParts = [];
    for (let i = 0; i < runs; i++) {
      const [scanMs, scan] = await time(() => analyzer.scanRepository(root, opts));
      const [gitMs, [idx, unt]] = await time(() => Promise.all([gi.listIndexEntries(root), gi.listUntrackedPaths(root), gi.listTypeChangedPaths(root)]));
      const [prefixMs] = await time(() => analyzer.probeWorkTree(root).prefix());
      const raw = [...idx.value.map((e) => e.path), ...unt.value];
      const [normMs, paths] = await time(() => raw.map((p) => core.normalizeRepoPath(p.endsWith("/") ? p.slice(0, -1) : p).value).filter(Boolean));
      const policy = createPathPolicy(opts.include, opts.exclude);
      const [policyMs] = await time(() => paths.map((p) => policy.exclusionOf(p)));
      const [buildMs] = await time(() => { const m = buildOutputMatcher(paths); return paths.map((p) => m(p)); });
      const dirs = new Set(); for (const p of paths) { const s = p.split("/"); for (let k = 1; k < s.length; k++) dirs.add(s.slice(0, k).join("/")); }
      const [lstatMs] = await time(() => { for (const p of paths) { try { fs.lstatSync(path.join(root, p)); } catch { /* missing: the scanner excludes it */ } } for (const d of dirs) { try { fs.lstatSync(path.join(root, d)); } catch { /* missing directory */ } } });
      const [joinMs] = await time(() => paths.map((p) => path.join(root, p)));
      const [collMs] = await time(() => core.findPathPortabilityCollisions(scan.files.map((f) => f.path)));
      scanParts.push({ scanMs, gitParallelMs: gitMs, prefixMs, normMs, policyMs, buildMs, lstatMs, joinMs, collMs, candidates: paths.length, directories: dirs.size, files: scan.files.length, excluded: scan.excluded.length });
    }
    const pick = (k) => r1(median(scanParts.map((x) => x[k])));
    out.scan = { candidates: scanParts[0].candidates, directories: scanParts[0].directories, files: scanParts[0].files, excluded: scanParts[0].excluded,
      excludedBy: Object.entries(warmScan.excluded.reduce((a, e) => ((a[e.reason] = (a[e.reason] ?? 0) + 1), a), {})),
      ms: { total: pick("scanMs"), gitThreeQueriesParallel: pick("gitParallelMs"), showPrefix: pick("prefixMs"), lstatFilesAndDirs: pick("lstatMs"), pathPolicy: pick("policyMs"), buildOutput: pick("buildMs"), normalizeRepoPath: pick("normMs"), pathJoin: pick("joinMs"), portabilityCollisions: pick("collMs") } };
    // ---- fingerprint per file (sequential reference, warm) ----
    const files = warmScan.files;
    const selection = registry.scope(files.map((f) => f.path).filter((p) => !p.startsWith(".duo-project/")));
    const levelOf = (p) => { if (p.startsWith(".duo-project/")) return "truth"; const a = selection.analyzerFor(p); return a === undefined ? "L0" : analyzer.analysisLevelOf(a.capabilities); };
    const catOf = (p) => {
      if (p.startsWith(".duo-project/")) return "truth";
      const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase(); const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      if (["meta", "unity", "prefab", "asset", "mat", "anim", "controller", "shader", "shadergraph", "uasset", "umap"].includes(ext)) return "." + ext;
      if (["cs", "ts", "tsx", "js", "jsx", "py", "java", "cpp", "h", "hpp", "cc", "c"].includes(ext)) return "source ." + ext;
      if (["json", "yaml", "yml", "md", "txt", "xml", "toml", "ini", "cfg", "html", "css"].includes(ext)) return "text ." + ext;
      if (["png", "jpg", "jpeg", "tga", "psd", "exr", "fbx", "wav", "ogg", "mp3", "ttf", "otf", "dll", "so", "bin"].includes(ext)) return "binary ." + ext;
      return "other";
    };
    const bucketOf = (n) => (n < 4096 ? "<4KB" : n < 65536 ? "4KB-64KB" : n < 1048576 ? "64KB-1MB" : ">1MB");
    const per = []; const buffers = [];
    for (const f of files) {
      const abs = path.join(root, f.path);
      let t = performance.now(); fs.lstatSync(abs); const lstat = performance.now() - t;
      t = performance.now(); const bytes = fs.readFileSync(abs); const read = performance.now() - t;
      const m = fingerprintModeOf(f.path);
      t = performance.now(); const canon = canonicalContent(bytes, m); const canonMs = performance.now() - t;
      t = performance.now(); crypto.createHash("sha256").update(canon).digest("hex"); const hash = performance.now() - t;
      per.push({ p: f.path, size: bytes.length, mode: m, level: levelOf(f.path), cat: catOf(f.path), lstat, read, canon: canonMs, hash });
      buffers.push([bytes, m]);
    }
    const agg = (key) => { const g = {}; for (const x of per) { const k = key(x); const a = (g[k] ??= { files: 0, bytes: 0, lstatMs: 0, readMs: 0, canonMs: 0, hashMs: 0 }); a.files++; a.bytes += x.size; a.lstatMs += x.lstat; a.readMs += x.read; a.canonMs += x.canon; a.hashMs += x.hash; }
      return Object.fromEntries(Object.entries(g).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, a]) => [k, { files: a.files, MB: r1(a.bytes / 1048576), lstatMs: r1(a.lstatMs), readMs: r1(a.readMs), canonMs: r1(a.canonMs), hashMs: r1(a.hashMs) }])); };
    const sum = (k) => r1(per.reduce((s, x) => s + x[k], 0));
    out.fingerprintSequential = { files: per.length, MB: r1(per.reduce((s, x) => s + x.size, 0) / 1048576), ms: { lstat: sum("lstat"), read: sum("read"), crlfCanonicalize: sum("canon"), sha256: sum("hash") },
      byCategory: agg((x) => x.cat), bySize: agg((x) => bucketOf(x.size)), byMode: agg((x) => x.mode), byLevel: agg((x) => x.level),
      largest: [...per].sort((a, b) => b.size - a.size).slice(0, 5).map((x) => ({ path: x.p, KB: Math.round(x.size / 1024), mode: x.mode, readMs: r1(x.read), canonMs: r1(x.canon), hashMs: r1(x.hash) })) };
    // ---- in-memory CPU: production canonicalization + SHA-256, and a Buffer.indexOf canonicalization ----
    const indexOfCanonical = (bytes, m) => {
      if (m === "raw") return bytes;
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      let i = buf.indexOf("\r\n"); if (i < 0) return bytes;
      const parts = []; let from = 0;
      while (i >= 0) { parts.push(buf.subarray(from, i)); from = i + 1; i = buf.indexOf("\r\n", i + 1); }
      parts.push(buf.subarray(from));
      return Buffer.concat(parts);
    };
    let identical = true;
    for (const [b, m] of buffers) if (Buffer.compare(Buffer.from(canonicalContent(b, m)), Buffer.from(indexOfCanonical(b, m))) !== 0) { identical = false; break; }
    const cpu = { production: [], hashOnly: [], indexOfVariant: [] };
    for (let i = 0; i < runs; i++) {
      let t = performance.now(); for (const [b, m] of buffers) computeContentHash(b, m); cpu.production.push(performance.now() - t);
      t = performance.now(); for (const [b, m] of buffers) crypto.createHash("sha256").update(m === "raw" ? b : b).digest("hex"); cpu.hashOnly.push(performance.now() - t);
      t = performance.now(); for (const [b, m] of buffers) crypto.createHash("sha256").update(indexOfCanonical(b, m)).digest("hex"); cpu.indexOfVariant.push(performance.now() - t);
    }
    out.inMemoryCpu = { productionCanonicalPlusSha256Ms: r1(median(cpu.production)), sha256OfRawBytesMs: r1(median(cpu.hashOnly)), indexOfCanonicalPlusSha256Ms: r1(median(cpu.indexOfVariant)), indexOfByteIdentical: identical };
    // ---- production fingerprint at several concurrency limits, interleaved ----
    const reference = JSON.stringify((await analyzer.fingerprintRepositoryFiles(root, files)).fingerprints);
    const st = new Map(limits.map((l) => [l, { ms: [], rss: 0, heap: 0, equal: true }]));
    for (let r = 0; r < runs; r++) {
      for (const l of r % 2 === 0 ? limits : [...limits].reverse()) {
        globalThis.gc?.(); const m0 = process.memoryUsage(); let pr = m0.rss, ph = m0.heapUsed;
        const timer = setInterval(() => { const m = process.memoryUsage(); pr = Math.max(pr, m.rss); ph = Math.max(ph, m.heapUsed); }, 2);
        const t = performance.now(); const fp = await analyzer.fingerprintRepositoryFiles(root, files, { concurrency: l }); const ms = performance.now() - t;
        clearInterval(timer); const s = st.get(l); s.ms.push(ms); s.rss = Math.max(s.rss, pr - m0.rss); s.heap = Math.max(s.heap, ph - m0.heapUsed);
        if (JSON.stringify(fp.fingerprints) !== reference) s.equal = false;
      }
    }
    out.fingerprintConcurrency = [...st].map(([l, s]) => ({ limit: l, medianMs: Math.round(median(s.ms)), worstMs: Math.round(Math.max(...s.ms)), rssGrowthMB: Math.round(s.rss / 1048576), heapGrowthMB: Math.round(s.heap / 1048576), equal: s.equal }));
  }
} finally { registry.dispose(); }
out.peakRssMB = Math.round(peakRss / 1048576); out.peakHeapMB = Math.round(peakHeap / 1048576);
console.log(JSON.stringify(out));

