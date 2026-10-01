// T25.1 cross-build freshness equivalence: the same mutation scenarios on copies of one fixture, each build in its
// own process, compared by digests of the full inspectIndex result (value and diagnostics), the incremental Graph
// and a clean full rebuild of the same tree. Extends T22's cache-prefetch-equivalence (which patched one build).
//   node bench/experiments/freshness-equivalence.mjs --builds 0=<checkout>,AB=<checkout> [--fixture medium] [--out file]
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const CACHE = path.join(".duo-project", "cache", "analysis");
const git = (root, ...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
const tracked = (root) => git(root, "ls-files").split(/\r?\n/u).filter(Boolean);
const firstSource = (root, ext) => tracked(root).find((f) => f.endsWith(ext) && !f.startsWith(".duo-project"));
const cacheEntries = (root) => fs.readdirSync(path.join(root, CACHE)).sort();
const SCENARIOS = {
  "no change": () => {},
  "TypeScript source edit": (r) => fs.appendFileSync(path.join(r, firstSource(r, ".ts")), "\nexport const t251Edit = 1;\n"),
  "source delete": (r) => fs.rmSync(path.join(r, firstSource(r, ".java") ?? firstSource(r, ".ts"))),
  "source rename": (r) => { const f = firstSource(r, ".py") ?? firstSource(r, ".ts"); fs.renameSync(path.join(r, f), path.join(r, f.replace(/(\.\w+)$/u, "_renamed$1"))); },
  "same bytes rewritten, timestamp only": (r) => { const f = path.join(r, firstSource(r, ".ts")); fs.writeFileSync(f, fs.readFileSync(f)); const t = new Date(Date.now() + 60_000); fs.utimesSync(f, t, t); },
  "cache entry truncated": (r) => fs.writeFileSync(path.join(r, CACHE, cacheEntries(r)[0]), "{"),
  "cache entry deleted": (r) => fs.rmSync(path.join(r, CACHE, cacheEntries(r)[1])),
  "cache entry replaced by another file's entry": (r) => { const [a, b] = cacheEntries(r); fs.copyFileSync(path.join(r, CACHE, b), path.join(r, CACHE, a)); },
  "new Java source": (r) => { fs.mkdirSync(path.join(r, "src", "t251"), { recursive: true }); fs.writeFileSync(path.join(r, "src", "t251", "Added.java"), "package t251;\n\npublic class Added {\n  public int one() { return 1; }\n}\n"); },
  "several cache entries broken at once": (r) => { const e = cacheEntries(r); fs.writeFileSync(path.join(r, CACHE, e[2]), "{"); fs.rmSync(path.join(r, CACHE, e[3])); fs.writeFileSync(path.join(r, CACHE, e[4]), "null"); },
};

if (arg("child") !== undefined) {
  // Child: one build, one prepared copy.
  const DUO = path.resolve(arg("duo-root")), root = arg("child");
  const req = createRequire(path.join(DUO, "package.json"));
  const product = (n) => import(pathToFileURL(req.resolve(n)).href);
  const { createDefaultAnalyzerRegistry } = await product("@duo-director/analyzer");
  const { dumpGraph, indexRepository, inspectIndex, openProjectGraphReader, openProjectGraphStore } = await product("@duo-director/graph");
  const registry = (await createDefaultAnalyzerRegistry()).value;
  const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
  const reader = openProjectGraphReader(root).value;
  const inspected = await inspectIndex(root, { graph: reader, registry });
  reader.close();
  let store = openProjectGraphStore(root).value;
  const indexed = await indexRepository(root, { store, registry });
  const graph = dumpGraph(store);
  store.close();
  const reader2 = openProjectGraphReader(root).value;
  const after = await inspectIndex(root, { graph: reader2, registry });
  reader2.close();
  store = openProjectGraphStore(root).value;
  await indexRepository(root, { store, registry, full: true });
  const full = dumpGraph(store);
  store.close();
  registry.dispose();
  console.log(JSON.stringify({
    status: inspected.value?.status, parse: inspected.value?.wouldRebuild.parse.length, inspect: sha({ value: inspected.value, diagnostics: inspected.diagnostics }),
    mode: indexed.value?.mode, analyzed: indexed.value?.metrics?.files?.analyzed, indexDiagnostics: sha(indexed.diagnostics), graph: sha(graph), afterStatus: after.value?.status, cleanFullEqual: JSON.stringify(graph) === JSON.stringify(full),
  }));
  process.exit(0);
}

const builds = arg("builds").split(",").map((b) => ({ name: b.slice(0, b.indexOf("=")), root: path.resolve(b.slice(b.indexOf("=") + 1)) }));
const source = fileURLToPath(new URL("../results/local/fixtures/" + (arg("fixture") ?? "medium") + "/", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const results = [];
const temps = [];
try {
  for (const [label, mutate] of Object.entries(SCENARIOS)) {
    const row = { scenario: label, builds: {} };
    for (const b of builds) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-t251-eq-"))); temps.push(root);
      fs.cpSync(source, root, { recursive: true });
      // Each copy is first indexed by its own build (an index this build wrote), then mutated.
      spawnSync(process.execPath, [path.join(b.root, "apps/cli/dist/main.js"), "index", "--json"], { cwd: root, encoding: "utf8", windowsHide: true });
      mutate(root);
      const r = spawnSync(process.execPath, [SELF, "--child", root, "--duo-root", b.root], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
      try { row.builds[b.name] = JSON.parse(r.stdout.trim().split(/\r?\n/u).at(-1)); } catch { row.builds[b.name] = { error: r.stderr.slice(0, 400) }; }
    }
    const values = Object.values(row.builds).map((x) => JSON.stringify(x));
    row.equal = values.every((v) => v === values[0]);
    results.push(row);
    console.error(label + ": " + (row.equal ? "equal" : "DIFFERENT") + " " + JSON.stringify(Object.values(row.builds)[0]));
  }
} finally {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 3 });
}
const out = { fixture: arg("fixture") ?? "medium", builds, allEqual: results.every((r) => r.equal && Object.values(r.builds).every((x) => x.cleanFullEqual && x.afterStatus === "current")), results };
if (arg("out") !== undefined) fs.writeFileSync(arg("out"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ allEqual: out.allEqual }));

