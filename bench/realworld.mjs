// T23 stable real-world runner: measures one pinned repository checkout in its own process (so RSS is its own).
//   node bench/realworld.mjs --repo <pristine checkout of the manifest SHA> --id <manifest id> [--runs 3] [--duo-root <DUO checkout>]
// Prints one JSON document (internal format duo.bench-realworld-run/2, not a DUO public contract) on stdout.
// --duo-root: the DUO build to measure (its CLI and packages; default: this checkout). The harness itself is always this
// file, so an A/B comparison measures two builds with the same accounting (T24.3, C230).
// /2 (C230): Context file accounting counts every Packet item by its file, File items (L1: path and language, no
// source) included, and records the best level per file; /1 counted only items with a source location.
// "deterministic" must be identical for the same repository SHA, DUO build and scenario; "timings", "memory" and
// "operations" are environment-dependent observations and never a gate. "checks" are the harness invariants:
// a failed check is a DUO correctness failure. Counters wrap Node built-ins in this process only; product code is unchanged.
// Needs pnpm build. Writes .duo-project and one appended declaration inside --repo (the suite resets the checkout).
import cp, { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EDITS, REPOS } from "./realworld-repos.mjs";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const repo = REPOS.find((r) => r.id === arg("id"));
if (repo === undefined || arg("repo") === undefined) throw new Error("usage: node bench/realworld.mjs --repo <checkout> --id <" + REPOS.map((r) => r.id).join("|") + "> [--runs N]");
const root = fs.realpathSync(path.resolve(arg("repo")));
const runs = Number(arg("runs") ?? 3);
const DUO = path.resolve(arg("duo-root") ?? fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(DUO, "apps", "cli", "dist", "main.js");
// The measured build's packages, resolved from its own checkout (never from this harness's node_modules).
const duoRequire = createRequire(path.join(DUO, "package.json"));
const product = (name) => import(pathToFileURL(duoRequire.resolve(name)).href);
const STATE = ".duo-project/";
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
// git config --get exits 1 when the key is unset (the Linux and macOS default for core.symlinks).
const gitConfig = (cwd, key) => { try { return git(cwd, "config", "--get", key) || "unset"; } catch { return "unset"; } };
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ms = (s) => Math.round(performance.now() - s);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const head = git(root, "rev-parse", "HEAD");
if (head !== repo.sha) throw new Error(repo.id + ": checkout is at " + head + ", manifest pins " + repo.sha);
if (git(root, "status", "--porcelain", "--untracked-files=all") !== "") throw new Error(repo.id + ": checkout is not pristine");

// Operation counters (installed before DUO modules load, so their imports see the wrappers).
const counters = new Map();
const add = (k) => counters.set(k, (counters.get(k) ?? 0) + 1);
for (const f of ["lstatSync", "statSync", "readFileSync", "openSync", "readdirSync"]) { const o = fs[f]; fs[f] = function (...a) { add("fs." + f); return o.apply(this, a); }; }
for (const f of ["lstat", "stat", "readFile", "open", "readdir"]) { const o = fs.promises[f]; fs.promises[f] = function (...a) { add("fs.promises." + f); return o.apply(this, a); }; }
const execFile = cp.execFile;
cp.execFile = function (file, ...rest) { add(String(file).toLowerCase().includes("git") ? "git" : "execFile"); return execFile.call(this, file, ...rest); };
syncBuiltinESMExports();
const snap = () => new Map(counters);
const since = (a) => Object.fromEntries([...counters].map(([k, v]) => [k, v - (a.get(k) ?? 0)]).filter(([, d]) => d > 0).sort(([a], [b]) => byText(a, b)));
let peakRss = 0, peakHeap = 0;
const mem = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };

const timings = {};
const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });

// 1. init through the CLI in a cold process, as a user runs it: Truth, first index, adoption baseline.
let s = performance.now();
const init = spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
timings.initCliMs = ms(s);
let initJson = null;
try { initJson = JSON.parse(init.stdout); } catch { /* reported by the check below */ }
check("init-succeeded", init.status === 0 && initJson !== null, init.status === 0 ? undefined : "exit " + init.status);

s = performance.now();
const { createDefaultAnalyzerRegistry, scanRepository } = await product("@duo-director/analyzer");
const { loadProjectTruth } = await product("@duo-director/core");
const { dumpGraph, indexRepository, inspectIndex, openProjectGraphReader, openProjectGraphStore } = await product("@duo-director/graph");
const { projectContext, projectReview } = await product("@duo-director/integration");
timings.importMs = ms(s);
s = performance.now();
const registry = (await createDefaultAnalyzerRegistry()).value;
timings.grammarLoadMs = ms(s);

const removeRegenerable = () => { for (const d of ["generated", "cache"]) fs.rmSync(path.join(root, ".duo-project", d), { recursive: true, force: true, maxRetries: 3 }); };
const graphOf = (store) => {
  const d = dumpGraph(store);
  const text = JSON.stringify(d);
  // Row digests per node kind (ID prefix) and edge type: localize a Graph difference (for example across OSes).
  const groups = new Map();
  const put = (k, row) => groups.set(k, [...(groups.get(k) ?? []), String(row)]);
  for (const n of d.nodes) put("node:" + String(JSON.parse(n).id).split(":")[0], n);
  for (const e of d.edges) put("edge:" + JSON.parse(e).type, e);
  const byKind = Object.fromEntries([...groups].sort(([a], [b]) => byText(a, b)).map(([k, rows]) => [k, rows.length + ":" + sha256(rows.sort(byText).join("\n")).slice(0, 16)]));
  return { summary: { nodes: d.nodes.length, edges: d.edges.length, sha256: sha256(text), byKind }, rows: d, text };
};
const index = async (label) => {
  const store = openProjectGraphStore(root).value;
  try {
    const before = snap();
    const t = performance.now();
    const r = await indexRepository(root, { store, registry });
    timings[label + "Ms"] = ms(t);
    const g = graphOf(store);
    mem();
    return { ok: r.value !== undefined, mode: r.value?.mode ?? null, analyzed: r.value?.metrics?.files?.analyzed ?? null, graph: g, operations: since(before) };
  } finally { store.close(); }
};
const inspect = async () => { const g = openProjectGraphReader(root).value; try { return (await inspectIndex(root, { graph: g, registry })).value; } finally { g.close(); } };

try {
  // 2. scan accounting. The scanner also fingerprints the Project Truth files under .duo-project/ (so Truth edits make
  // the index stale); coverage and the Graph count repository files only. T22's "4 files" were these Truth files.
  const truth = loadProjectTruth(root).value.truth;
  const scan = await scanRepository(root, { include: truth.config.index.include, exclude: truth.config.index.exclude });
  const truthFiles = scan.files.map((f) => f.path).filter((p) => p.startsWith(STATE)).sort(byText);
  const repoFiles = scan.files.map((f) => f.path).filter((p) => !p.startsWith(STATE)).sort(byText);
  const excluded = {};
  for (const e of scan.excluded) excluded[e.reason] = (excluded[e.reason] ?? 0) + 1;
  const lower = new Set(repoFiles.map((p) => p.toLowerCase()));

  // 3. initial index from regenerable state removed (graph, index state, caches).
  removeRegenerable();
  const initial = await index("initialIndex");
  check("initial-index", initial.ok && initial.mode === "full");

  // 4. no-op freshness (shared registry: the long-lived MCP/UI case), first warm-up call not timed.
  await inspect();
  const noop = [];
  let noopResult, noopOps;
  for (let i = 0; i < runs; i++) { const before = snap(); const t = performance.now(); noopResult = await inspect(); noop.push(ms(t)); noopOps = since(before); }
  timings.noopFreshnessMs = { median: median(noop), runs: noop };
  mem();
  const coverage = noopResult.coverage;
  check("noop-current", noopResult.status === "current" && noopResult.wouldRebuild.parse.length === 0, noopResult.status);
  check("scan-accounting", repoFiles.length === coverage.files.total, repoFiles.length + " repository files vs coverage " + coverage.files.total + ", Truth files " + truthFiles.length);
  for (const [language, level] of Object.entries(repo.levels)) {
    const l = coverage.languages.find((x) => x.language === language);
    check("level:" + language, l?.level === level, l === undefined ? "absent" : l.level);
  }

  // 5. Context scenarios on the pristine pinned tree.
  const contexts = {};
  timings.contextMs = {};
  for (const sc of repo.scenarios) {
    const t = [];
    let payload;
    for (let i = 0; i < 2; i++) { const t0 = performance.now(); const op = await projectContext(root, { task: sc.task }, { registry }); t.push(ms(t0)); payload = op.kind === "ok" ? op.payload : undefined; }
    mem();
    timings.contextMs[sc.id] = t;
    const packet = payload?.context?.packet;
    const items = packet === undefined ? [] : [...packet.code, ...packet.tests];
    // A File item (kind "file") has no source: its ref is the repository path. Symbol and Test items carry their source.
    const fileOf = (x) => (x.kind === "file" ? x.ref : x.source?.path);
    const levelOf = new Map();
    for (const x of items) { const f = fileOf(x); if (f !== undefined && byText(levelOf.get(f) ?? "", x.level) < 0) levelOf.set(f, x.level); }
    const files = [...levelOf.keys()].sort(byText);
    const found = sc.expect.filter((e) => files.some((f) => f.endsWith(e)));
    contexts[sc.id] = {
      status: payload?.status ?? "failed", files, levels: Object.fromEntries(files.map((f) => [f, levelOf.get(f)])), found, missing: sc.expect.filter((e) => !found.includes(e)),
      dependencyDigest: packet?.dependencyDigest ?? null, omitted: packet?.omittedCandidates?.length ?? null, truncated: packet?.truncated ?? null,
    };
  }

  // 6. deterministic one-file edit → incremental index → Graph; then a clean full rebuild of the same tree → Graph.
  const editFile = path.join(root, repo.edit.path);
  const original = fs.readFileSync(editFile, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const appended = (original.endsWith("\n") ? "" : eol) + EDITS[repo.edit.kind].join(eol) + eol;
  fs.appendFileSync(editFile, appended);
  const incremental = await index("incrementalIndex");
  check("incremental-one-file", incremental.ok && incremental.mode === "incremental" && incremental.analyzed === 1, incremental.mode + ", analyzed " + incremental.analyzed);
  const afterEdit = await inspect();
  check("current-after-incremental", afterEdit.status === "current", afterEdit.status);
  removeRegenerable();
  const full = await index("cleanFullIndex");
  const equal = incremental.graph.text === full.graph.text;
  let graphDiff;
  if (!equal) {
    const rows = (g) => new Set([...g.rows.nodes, ...g.rows.edges].map(String));
    const a = rows(incremental.graph), b = rows(full.graph);
    graphDiff = { onlyIncremental: [...a].filter((x) => !b.has(x)).slice(0, 10), onlyFull: [...b].filter((x) => !a.has(x)).slice(0, 10) };
  }
  check("incremental-equals-clean-full", equal, graphDiff);
  const probe = incremental.graph.rows.nodes.map(String).filter((n) => /duo_?bench_?probe/iu.test(n)).length;
  check("edit-detected", probe > 0, probe + " Graph rows name the appended declaration");

  // 7. Review of the edit (HEAD → WORKTREE).
  s = performance.now();
  const rv = await projectReview(root, { task: repo.scenarios[0].task, diff: { from: "HEAD", to: "WORKTREE" } }, { registry });
  timings.reviewMs = ms(s);
  mem();
  const review = rv.kind === "ok" ? rv.payload : undefined;
  const claims = (review?.claims ?? []).map((c) => [c.alignment, c.rule ?? c.kind ?? "", c.subject?.id ?? c.subject ?? ""].map(String).join(" ")).sort(byText);

  const deterministic = {
    init: { exit: init.status, baseline: initJson?.result?.baseline?.status ?? null },
    scan: { total: scan.files.length, projectTruth: { files: truthFiles.length, paths: truthFiles }, repository: { files: repoFiles.length, pathsSha256: sha256(repoFiles.join("\n")) }, excluded },
    coverage: {
      files: coverage.files,
      languages: coverage.languages.map((l) => ({ language: l.language, files: l.files, level: l.level, analyzer: l.analyzer })),
      fileOnlyExtensions: coverage.fileOnlyExtensions,
    },
    graph: { initial: initial.graph.summary, incremental: incremental.graph.summary, cleanFull: full.graph.summary, incrementalEqualsCleanFull: equal },
    noop: { status: noopResult.status, parse: noopResult.wouldRebuild.parse.length },
    edit: { path: repo.edit.path, kind: repo.edit.kind, eol: eol === "\r\n" ? "crlf" : "lf", appendedBytes: Buffer.byteLength(appended), mode: incremental.mode, analyzed: incremental.analyzed },
    context: contexts,
    review: { verdict: review?.verdict ?? null, claims },
  };
  const serialized = JSON.stringify(deterministic);
  check("no-absolute-path", !serialized.includes(root) && !serialized.includes(root.split(path.sep).join("/")));

  console.log(JSON.stringify({
    format: "duo.bench-realworld-run/2",
    repo: { id: repo.id, sha: head, shape: repo.shape },
    build: {
      duoCommit: git(DUO, "rev-parse", "HEAD"), duoDirty: git(DUO, "status", "--porcelain", "--untracked-files=no") !== "",
      analyzerRegistryDigest: coverage.analyzerRegistryDigest, node: process.version, platform: process.platform, arch: process.arch,
    },
    environment: {
      git: git(root, "--version"), coreSymlinks: gitConfig(root, "core.symlinks"), coreAutocrlf: gitConfig(root, "core.autocrlf"),
      maxPath: { repository: Math.max(...repoFiles.map((p) => p.length)), absolute: root.length + 1 + Math.max(...repoFiles.map((p) => p.length)) },
      caseCollisions: repoFiles.length - lower.size,
    },
    deterministic,
    timings,
    memory: { peakRssMB: Math.round(peakRss / 1048576), peakHeapMB: Math.round(peakHeap / 1048576) },
    operations: { noopFreshness: noopOps, incrementalIndex: incremental.operations },
    checks,
  }, null, 1));
} finally {
  registry.dispose();
}

