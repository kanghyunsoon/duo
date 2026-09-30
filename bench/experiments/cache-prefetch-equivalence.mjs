// T22-A experiment: can the analysis-cache check read its entries with parallel async I/O without changing any
// result? The production code is not changed. "prefetch" reads every entry of .duo-project/cache/analysis with
// bounded concurrency first, then serves those bytes to the unchanged production code through fs.readFileSync.
// The symlink checks (lstat), JSON parsing and key validation still run exactly as in production.
//
// For each scenario (a fresh copy of the fixture per mode) it compares:
//   inspectIndex (full result)              sequential  vs prefetch
//   indexRepository then dumpGraph          sequential  vs prefetch  vs clean full rebuild
//
//   node bench/experiments/cache-prefetch-equivalence.mjs [medium] [--concurrency 64]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "medium";
const ci = process.argv.indexOf("--concurrency");
const concurrency = ci < 0 ? 64 : Number(process.argv[ci + 1]);
const source = fileURLToPath(new URL("../results/local/fixtures/" + name + "/", import.meta.url));
const CACHE = path.join(".duo-project", "cache", "analysis");

const originalRead = fs.readFileSync;
let served = null; // Map absolute path → Buffer while prefetching
function patchedRead(p, options) {
  if (served !== null && typeof p === "string") {
    const hit = served.get(path.resolve(p));
    if (hit !== undefined) return options === "utf8" || options?.encoding === "utf8" ? hit.toString("utf8") : Buffer.from(hit);
  }
  return originalRead.call(fs, p, options);
}
fs.readFileSync = patchedRead;
syncBuiltinESMExports();

const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { dumpGraph, indexRepository, inspectIndex, openProjectGraphReader, openProjectGraphStore } = await import("@duo-director/graph");
const registry = (await createDefaultAnalyzerRegistry()).value;

async function prefetch(root) {
  const dir = path.join(root, CACHE);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const map = new Map();
  let next = 0;
  const worker = async () => { while (next < names.length) { const f = path.join(dir, names[next++]); try { map.set(path.resolve(f), await fs.promises.readFile(f)); } catch { /* vanished: production then sees ENOENT */ } } };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return map;
}
async function withMode(mode, root, fn) {
  if (mode === "prefetch") served = await prefetch(root);
  try { return await fn(); } finally { served = null; }
}
const copy = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-prefetch-"))); fs.cpSync(source, d, { recursive: true }); return d; };
const git = (root, ...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
const tracked = (root) => git(root, "ls-files").split(/\r?\n/u).filter(Boolean);
const cacheEntries = (root) => fs.readdirSync(path.join(root, CACHE)).sort();
const firstSource = (root, ext) => tracked(root).find((f) => f.endsWith(ext) && !f.startsWith(".duo-project"));

const scenarios = {
  "no change": () => {},
  "edit a TypeScript file": (r) => { const f = firstSource(r, ".ts"); fs.appendFileSync(path.join(r, f), "\nexport const t22Edit = 1;\n"); },
  "delete a source file": (r) => fs.rmSync(path.join(r, firstSource(r, ".java") ?? firstSource(r, ".ts"))),
  "rename a source file": (r) => { const f = firstSource(r, ".py") ?? firstSource(r, ".ts"); fs.renameSync(path.join(r, f), path.join(r, f.replace(/(\.\w+)$/u, "_renamed$1"))); },
  "same bytes rewritten (mtime only)": (r) => { const f = path.join(r, firstSource(r, ".ts")); const b = fs.readFileSync(f); fs.writeFileSync(f, b); const t = new Date(Date.now() + 60_000); fs.utimesSync(f, t, t); },
  "cache entry truncated": (r) => { const e = cacheEntries(r)[0]; fs.writeFileSync(path.join(r, CACHE, e), "{"); },
  "cache entry removed": (r) => fs.rmSync(path.join(r, CACHE, cacheEntries(r)[1])),
  "cache entry swapped with another file's entry": (r) => { const [a, b] = cacheEntries(r); fs.copyFileSync(path.join(r, CACHE, b), path.join(r, CACHE, a)); },
  "new Java file": (r) => { fs.mkdirSync(path.join(r, "src", "t22"), { recursive: true }); fs.writeFileSync(path.join(r, "src", "t22", "Added.java"), "package t22;\n\npublic class Added {\n  public int one() { return 1; }\n}\n"); },
};

const results = [];
const temps = [];
try {
  for (const [label, mutate] of Object.entries(scenarios)) {
    const out = { scenario: label };
    const run = {};
    for (const mode of ["sequential", "prefetch"]) {
      const root = copy(); temps.push(root);
      mutate(root);
      const reader = openProjectGraphReader(root).value;
      const s = performance.now();
      const inspected = await withMode(mode, root, () => inspectIndex(root, { graph: reader, registry }));
      const inspectMs = performance.now() - s;
      reader.close();
      const store = openProjectGraphStore(root).value;
      const indexed = await withMode(mode, root, () => indexRepository(root, { store, registry }));
      const graph = JSON.stringify(dumpGraph(store));
      store.close();
      run[mode] = { root, inspect: JSON.stringify(inspected), status: inspected.value?.status, parse: inspected.value?.wouldRebuild.parse.length, inspectMs, graph, indexOk: indexed.value !== undefined };
    }
    // clean full rebuild of the sequential copy's final state
    const store = openProjectGraphStore(run.sequential.root).value;
    await indexRepository(run.sequential.root, { store, registry, full: true });
    const full = JSON.stringify(dumpGraph(store));
    store.close();
    Object.assign(out, {
      status: run.sequential.status, wouldParse: run.sequential.parse,
      inspectEqual: run.sequential.inspect === run.prefetch.inspect,
      graphEqual: run.sequential.graph === run.prefetch.graph,
      cleanFullEqual: run.sequential.graph === full,
      indexOk: run.sequential.indexOk && run.prefetch.indexOk,
      inspectMs: { sequential: Math.round(run.sequential.inspectMs), prefetchIncluded: Math.round(run.prefetch.inspectMs) },
    });
    results.push(out);
    console.error(JSON.stringify(out));
  }
} finally {
  registry.dispose();
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 3 });
}
console.log(JSON.stringify({ fixture: name, concurrency, allEqual: results.every((r) => r.inspectEqual && r.graphEqual && r.cleanFullEqual && r.indexOk), results }, null, 1));

