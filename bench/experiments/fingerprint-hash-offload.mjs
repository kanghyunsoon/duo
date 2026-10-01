// T25.2 experiment: SHA-256 of the fingerprint off the main thread (crypto.subtle.digest runs on the libuv thread
// pool) against the production fingerprint, interleaved per round, on one indexed repository. Each variant does what
// production does per file (lstat, regular-file check, readFile, CRLF canonicalization by fingerprint mode) and only
// moves the digest; results are compared with production (path, mode, contentHash, size, gitBlobOid).
//   node --expose-gc bench/experiments/fingerprint-hash-offload.mjs --repo <indexed checkout> [--rounds 7]
//        [--variants sync16,subtle16,subtle32,subtle16@65536,subtle16@1048576]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const DUO = path.resolve(arg("duo-root") ?? fileURLToPath(new URL("../..", import.meta.url)));
const root = fs.realpathSync(path.resolve(arg("repo")));
const rounds = Number(arg("rounds") ?? 7);
const dist = (p) => import(pathToFileURL(path.join(DUO, "packages/analyzer/dist", p)).href);
const { scanRepository, fingerprintRepositoryFiles } = await dist("index.js");
const { canonicalContent, CONTENT_HASH_PREFIX } = await dist("fingerprint/content-hash.js");
const { fingerprintModeOf } = await dist("fingerprint/fingerprint-mode.js");
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const hex = (ab) => Buffer.from(ab).toString("hex");

function variant(concurrency, threshold) {
  return async (files) => {
    const out = new Array(files.length);
    let next = 0;
    const one = async (file) => {
      const absolute = path.join(root, file.path);
      try {
        const stat = await fs.promises.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
        const mode = fingerprintModeOf(file.path);
        const canonical = canonicalContent(await fs.promises.readFile(absolute), mode);
        const digest = canonical.length >= threshold ? hex(await crypto.subtle.digest("SHA-256", canonical)) : crypto.createHash("sha256").update(canonical).digest("hex");
        const base = { path: file.path, state: file.state, fingerprintMode: mode, contentHash: CONTENT_HASH_PREFIX + digest, size: canonical.length };
        return file.gitBlobOid === undefined ? base : { ...base, gitBlobOid: file.gitBlobOid };
      } catch { return undefined; }
    };
    const worker = async () => { while (next < files.length) { const i = next++; out[i] = await one(files[i]); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    return out.filter(Boolean).sort((a, b) => (Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))));
  };
}
const names = (arg("variants") ?? "sync16,subtle16,subtle32,subtle16@65536,subtle16@1048576").split(",");
const fns = names.map((n) => {
  if (n === "sync16") return [n, async (files) => (await fingerprintRepositoryFiles(root, files)).fingerprints];
  const m = /^subtle(\d+)(?:@(\d+))?$/u.exec(n);
  return [n, variant(Number(m[1]), Number(m[2] ?? 0))];
});
const scan = await scanRepository(root);
const files = scan.files;
const reference = JSON.stringify((await fingerprintRepositoryFiles(root, files)).fingerprints);
for (const [, fn] of fns) await fn(files); // warm
const st = new Map(fns.map(([n]) => [n, { ms: [], cpu: [], rss: 0, heap: 0, equal: true }]));
for (let r = 0; r < rounds; r++) {
  for (const [n, fn] of r % 2 === 0 ? fns : [...fns].reverse()) {
    globalThis.gc?.();
    const m0 = process.memoryUsage(); let pr = m0.rss, ph = m0.heapUsed;
    const timer = setInterval(() => { const m = process.memoryUsage(); pr = Math.max(pr, m.rss); ph = Math.max(ph, m.heapUsed); }, 2);
    const c0 = process.cpuUsage(); const t = performance.now();
    const fp = await fn(files);
    const ms = performance.now() - t; const c = process.cpuUsage(c0);
    clearInterval(timer);
    const s = st.get(n); s.ms.push(ms); s.cpu.push((c.user + c.system) / 1000); s.rss = Math.max(s.rss, pr - m0.rss); s.heap = Math.max(s.heap, ph - m0.heapUsed);
    if (JSON.stringify(fp) !== reference) s.equal = false;
  }
}
await new Promise((r) => setImmediate(r));
console.log(JSON.stringify({ repo: path.basename(root), files: files.length, rounds, platform: process.platform, threadpool: process.env.UV_THREADPOOL_SIZE ?? "default(4)", cpus: (await import("node:os")).availableParallelism(),
  variants: [...st].map(([n, s]) => ({ name: n, medianMs: Math.round(median(s.ms)), worstMs: Math.round(Math.max(...s.ms)), cpuMs: Math.round(median(s.cpu)), rssGrowthMB: Math.round(s.rss / 1048576), heapGrowthMB: Math.round(s.heap / 1048576), equal: s.equal })) }));

