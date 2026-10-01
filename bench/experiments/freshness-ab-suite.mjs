// T25.1 same-session A/B of freshness across DUO builds. Prepares one copy per build and repository (real-world: a
// clone of the T23 pinned checkout, initialized by that build's CLI; synthetic: a copy of the benchmark fixture,
// indexed by that build), then measures builds alternately per repository with bench/experiments/freshness-ab.mjs.
//   node bench/experiments/freshness-ab-suite.mjs --builds 0=<checkout>,AB=<checkout> [--only ids] [--synthetic small,medium,large] [--rounds 1] [--runs 5] --out <file>
// --reuse keeps copies prepared by an earlier run. --interleave N measures N iterations, each running every build once
// per repository in a rotated order (one process each: --runs no-op inspects and one edit), so machine drift spreads
// evenly over the builds instead of landing on one build's block of runs.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPOS } from "../realworld-repos.mjs";

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i < 0 ? undefined : process.argv[i + 1]; };
const builds = (arg("builds") ?? "").split(",").filter(Boolean).map((b) => { const [name, p] = [b.slice(0, b.indexOf("=")), b.slice(b.indexOf("=") + 1)]; return { name, root: path.resolve(p) }; });
const only = arg("only")?.split(",");
const synthetic = arg("synthetic")?.split(",") ?? [];
const runs = arg("runs") ?? "5";
const rounds = Number(arg("rounds") ?? 1);
const interleave = arg("interleave") === undefined ? undefined : Number(arg("interleave"));
const reuse = process.argv.includes("--reuse");
const WORK = path.join(os.tmpdir(), "duo-t251");
const RUNNER = fileURLToPath(new URL("./freshness-ab.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../results/local/fixtures/", import.meta.url));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 }).trim();
const cli = (b, cwd, args, input) => spawnSync(process.execPath, [path.join(b.root, "apps/cli/dist/main.js"), ...args, "--json"], { cwd, input: input ?? "", encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 });

const targets = [
  ...REPOS.filter((r) => only === undefined || only.includes(r.id)).map((r) => ({ id: r.id, real: r, edit: r.edit.path + ":" + r.edit.kind })),
  ...synthetic.map((s) => ({ id: "synthetic-" + s, fixture: path.join(FIXTURES, s) })),
];
const prepared = new Map();
for (const t of targets) {
  for (const b of builds) {
    const dir = path.join(WORK, b.name, t.id);
    if (reuse && fs.existsSync(path.join(dir, ".duo-project", "generated"))) {
      if (t.real === undefined && t.edit === undefined) t.edit = git(dir, "ls-files").split(/\r?\n/u).find((f) => f.endsWith(".ts") && !f.startsWith(".duo-project")) + ":ts";
      prepared.set(b.name + "/" + t.id, dir);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (t.real !== undefined) {
      git(path.dirname(dir), "clone", "-q", "--no-hardlinks", path.join(os.tmpdir(), "duo-bench-repos", t.id), path.basename(dir));
      git(dir, "checkout", "-q", t.real.sha);
      const r = cli(b, dir, ["init", "--non-interactive", "--answers", "-", "--baseline-policy", "head"], "[]");
      if (r.status !== 0) throw new Error(t.id + " init with " + b.name + " failed: " + r.stdout.slice(0, 300) + r.stderr.slice(0, 300));
    } else {
      fs.cpSync(t.fixture, dir, { recursive: true });
      const r = cli(b, dir, ["index"]);
      if (r.status !== 0) throw new Error(t.id + " index with " + b.name + " failed: " + r.stdout.slice(0, 300));
      if (t.edit === undefined) t.edit = git(dir, "ls-files").split(/\r?\n/u).find((f) => f.endsWith(".ts") && !f.startsWith(".duo-project")) + ":ts";
    }
    prepared.set(b.name + "/" + t.id, dir);
    console.error("prepared " + b.name + " " + t.id);
  }
}
const results = [];
const runOne = (b, t, extra) => {
  const dir = prepared.get(b.name + "/" + t.id);
  const r = spawnSync(process.execPath, [RUNNER, "--duo-root", b.root, "--repo", dir, "--runs", runs, ...extra], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
  try { return JSON.parse(r.stdout.trim().split(/\r?\n/u).at(-1)); } catch { return { error: r.stderr.slice(0, 500) }; }
};
if (interleave !== undefined) {
  for (let i = 0; i < interleave; i++) {
    for (const t of targets) {
      const order = builds.map((_, k) => builds[(k + i) % builds.length]);
      for (const b of order) {
        const plain = runOne(b, t, ["--edit", t.edit, "--edit-runs", "1"]);
        results.push({ round: i, target: t.id, build: b.name, plain });
        console.error(i + " " + t.id + " " + b.name + " noop " + plain.noop?.totalMs?.median + " ms, analysis " + plain.noop?.phasesMs?.analysis + " ms");
      }
    }
  }
}
for (let round = 0; interleave === undefined && round < rounds; round++) {
  for (const t of targets) {
    for (const b of (round % 2 === 0 ? builds : [...builds].reverse())) {
      const dir = prepared.get(b.name + "/" + t.id);
      const run = (extra) => {
        const r = spawnSync(process.execPath, [RUNNER, "--duo-root", b.root, "--repo", dir, "--runs", runs, ...extra], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
        try { return JSON.parse(r.stdout.trim().split(/\r?\n/u).at(-1)); } catch { return { error: r.stderr.slice(0, 500) }; }
      };
      const plain = run(["--edit", t.edit]);
      const counted = run(["--count", "--runs", "1"]);
      results.push({ round, target: t.id, build: b.name, plain, counted });
      console.error(t.id + " " + b.name + " noop " + plain.noop?.totalMs?.median + " ms, edit inspect " + plain.edit?.staleInspectMs + " ms");
    }
  }
}
fs.writeFileSync(arg("out"), JSON.stringify({ format: "duo.t251-freshness-ab/1", builds, runs: Number(runs), rounds, node: process.version, platform: process.platform, results }, null, 1));
console.error("wrote " + arg("out"));

