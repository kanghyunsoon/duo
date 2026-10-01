// T23 real-world benchmark suite: fetches each manifest repository at its pinned SHA (depth 1, no branch or tag),
// resets it to a pristine checkout and runs bench/realworld.mjs on it, one process per repository.
//   node bench/realworld-suite.mjs [--only id,id | --ci] [--out file] [--duo-root <DUO checkout>] [--runs N]
//                                  [--work <dir>] [--fetch-only | --no-fetch] [--keep] [--cleanup]
// --duo-root measures another DUO checkout's build (its CLI and packages) with this checkout's runner on the same pinned
// repositories: the A/B setup. Both sides use the same harness and accounting (T24.3, C230); the other checkout only needs pnpm build.
// Clones live under --work (default: <OS temp>/duo-bench-repos), never inside the DUO repository; they are removed after
// measuring unless --keep. Result (internal format duo.bench-realworld/2): --out, default bench/results/local/realworld.json.
// Exit: 0 ok, 1 DUO correctness failure (a runner check failed), 3 harness failure, 2 network failure (fetch).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FORMAT, REPOS } from "./realworld-repos.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const arg = (n) => { const i = argv.indexOf("--" + n); return i < 0 ? undefined : argv[i + 1]; };
const here = fileURLToPath(new URL("..", import.meta.url));
const duoRoot = path.resolve(arg("duo-root") ?? here);
const work = path.resolve(arg("work") ?? path.join(os.tmpdir(), "duo-bench-repos"));
const out = path.resolve(arg("out") ?? path.join(here, "bench", "results", "local", "realworld.json"));
const runs = arg("runs") ?? "3";
const only = arg("only")?.split(",").filter(Boolean);
const selected = REPOS.filter((r) => (only === undefined || only.includes(r.id)) && (!flag("ci") || r.ci));
if (only !== undefined) for (const id of only) if (!REPOS.some((r) => r.id === id)) throw new Error("unknown repository id " + id);
const runner = path.join(here, "bench", "realworld.mjs");
const scrub = (t) => String(t).split(work).join("<work>").split(duoRoot).join("<duo>").split(os.homedir()).join("<home>").slice(-3000);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

if (flag("cleanup")) { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); console.error("removed " + scrub(work)); process.exit(0); }
let gitVersion;
try { gitVersion = git(here, "--version"); } catch (e) { console.error("harness failure: git is not available: " + scrub(e.message)); process.exit(3); }
if (!flag("fetch-only") && !fs.existsSync(path.join(duoRoot, "package.json"))) { console.error("harness failure: --duo-root is not a DUO checkout"); process.exit(3); }
if (!flag("fetch-only") && !fs.existsSync(path.join(duoRoot, "apps", "cli", "dist", "main.js"))) { console.error("harness failure: --duo-root is not built (pnpm build)"); process.exit(3); }

// Minimal fetch of one commit. core.autocrlf=false keeps bytes as committed on every OS (no CRLF rewriting);
// core.longpaths=true lets Git for Windows check out paths beyond MAX_PATH. Nothing else in the repository is changed.
function fetchPinned(r, dir) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    try { git(dir, "cat-file", "-e", r.sha + "^{commit}"); return "cached"; } catch { /* fetch below */ }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "core.longpaths", "true");
    git(dir, "remote", "add", "origin", r.url);
  }
  git(dir, "-c", "protocol.version=2", "fetch", "-q", "--depth", "1", "--no-tags", "origin", r.sha);
  return "fetched";
}
function pristine(r, dir) {
  git(dir, "checkout", "-q", "--force", "-B", "duo-bench", r.sha);
  git(dir, "clean", "-q", "-ffdx");
  return git(dir, "rev-parse", "HEAD");
}

const results = {};
let worst = 0;
const severity = { 0: 0, 2: 1, 3: 2, 1: 3 };
const fail = (code) => { if (severity[code] > severity[worst]) worst = code; };
for (const r of selected) {
  const dir = path.join(work, r.id);
  if (!flag("no-fetch")) {
    try { console.error(r.id + ": " + fetchPinned(r, dir) + " " + r.sha.slice(0, 12)); }
    catch (e) { results[r.id] = { status: "network-failure", sha: r.sha, error: scrub(e.stderr || e.message) }; fail(2); console.error(r.id + ": network failure"); continue; }
  }
  if (flag("fetch-only")) { results[r.id] = { status: "fetched", sha: r.sha }; continue; }
  let head;
  try { head = pristine(r, dir); } catch (e) { results[r.id] = { status: "harness-failure", sha: r.sha, error: "checkout: " + scrub(e.stderr || e.message) }; fail(3); continue; }
  if (head !== r.sha) { results[r.id] = { status: "harness-failure", sha: r.sha, error: "checkout at " + head }; fail(3); continue; }
  console.error(r.id + ": measuring");
  const p = spawnSync(process.execPath, [runner, "--repo", dir, "--id", r.id, "--runs", runs, "--duo-root", duoRoot], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  let run;
  try { run = JSON.parse(p.stdout); } catch { /* below */ }
  if (p.status !== 0 || run?.format !== "duo.bench-realworld-run/2") {
    results[r.id] = { status: "harness-failure", sha: r.sha, error: scrub(p.stderr || p.stdout || "exit " + p.status) }; fail(3);
  } else {
    const failed = run.checks.filter((c) => !c.ok);
    results[r.id] = { status: failed.length === 0 ? "ok" : "correctness-failure", ...(failed.length === 0 ? {} : { failedChecks: failed.map((c) => c.id) }), run };
    if (failed.length) fail(1);
    const d = run.deterministic;
    console.error("  " + results[r.id].status + ": " + d.scan.repository.files + " files (+" + d.scan.projectTruth.files + " Truth), noop " + run.timings.noopFreshnessMs.median
      + " ms, incremental " + run.timings.incrementalIndexMs + " ms, clean-full equal " + d.graph.incrementalEqualsCleanFull);
  }
  if (!flag("keep")) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!flag("fetch-only")) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    format: "duo.bench-realworld/2", manifest: MANIFEST_FORMAT, runs: Number(runs),
    machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, git: gitVersion },
    results,
  }, null, 1) + "\n");
  console.error("wrote " + scrub(out));
}
const summary = Object.entries(results).map(([id, v]) => id + "=" + v.status).join(", ");
console.error(summary || "no repository selected");
process.exit(worst);

