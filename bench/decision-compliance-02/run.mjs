#!/usr/bin/env node
// Decision Compliance Benchmark 2 runner: published DUO and DIY-0/1/2 on the generated timeline.
// DUO under test is the npm registry package, installed into a temporary prefix with an empty npm config; no
// workspace code is used. Adoption happens once at T0; each scenario is then reviewed on its own range.
// Writes raw evidence (machine-specific paths replaced) and a summary.
//   node bench/decision-compliance-02/run.mjs [--version 0.2.0] [--runs 10] [--evidence <dir>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReview, sha256 } from "../decision-compliance/canonical.mjs";
import { FIXTURE_VERSION, POLICY_D001, POLICY_D002, ROLES, TIMELINE, generateFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
const VERSION = arg("version", "0.2.0");
const RUNS = Number(arg("runs", "10"));
const OUT = path.resolve(arg("evidence", path.join(here, "evidence")));
const REGISTRY = "https://registry.npmjs.org/";
const IS_WIN = process.platform === "win32";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc02-")));
const prefix = path.join(tmp, "prefix");
const repo = path.join(tmp, "repo");
const state = path.join(tmp, "state");
fs.mkdirSync(state);
const userconfig = path.join(tmp, "npmrc");
fs.writeFileSync(userconfig, "");
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|NPM_|NODE_OPTIONS$)/u.test(k)));
const npm = (args) => spawnSync(IS_WIN ? "npm.cmd" : "npm", [...args, "--userconfig", userconfig, "--cache", path.join(tmp, "cache"), "--registry", REGISTRY], { encoding: "utf8", env: npmEnv, shell: IS_WIN, windowsHide: true });

const variants = (p) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\")];
const scrubPairs = [...variants(repo).map((v) => [v, "<fixture>"]), ...variants(tmp).map((v) => [v, "<tmp>"]), ...variants(os.homedir()).map((v) => [v, "<home>"])];
const scrub = (text) => scrubPairs.reduce((t, [from, to]) => t.split(from).join(to), String(text));
const save = (rel, text) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, scrub(text)); };
const firstLine = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true }).split("\n")[0].trim(); } catch { return null; } };
const environment = {
  date: new Date().toISOString().slice(0, 10), os: os.type() + " " + os.release() + " " + os.arch(), node: process.version,
  git: firstLine("git", ["--version"]), cpu: os.cpus()[0]?.model?.trim() ?? null, logicalCpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10,
};

// ---- published DUO ----
const view = npm(["view", "@duo-director/cli@" + VERSION, "version", "dist.integrity", "dist.shasum", "--json"]);
if (view.status !== 0) throw new Error("npm view failed: " + view.stderr);
const registry = JSON.parse(view.stdout);
if (npm(["install", "-g", "@duo-director/cli@" + VERSION, "--prefix", prefix, "--no-audit", "--no-fund"]).status !== 0) throw new Error("npm install failed");
const pkgDir = [path.join(prefix, "node_modules", "@duo-director", "cli"), path.join(prefix, "lib", "node_modules", "@duo-director", "cli")].find((d) => fs.existsSync(d));
const entry = path.join(pkgDir, "dist", "duoctl.js");
const duo = (args, input, cwd = repo) => {
  const p = spawnSync(process.execPath, [entry, ...args], { cwd, input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DUO_LOCALE: "en", NO_COLOR: "1" } });
  return { code: p.status, stdout: p.stdout, stderr: p.stderr };
};
const subject = { package: "@duo-director/cli", version: registry.version, integrity: registry["dist.integrity"], shasum: registry["dist.shasum"],
  installedVersion: JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version, duoctlVersion: duo(["--version"], undefined, tmp).stdout.trim() };

// ---- timeline ----
const commits = generateFixture(repo);
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const SCENARIOS = [
  { id: "t1-bypassed", branch: "t1-late-violation", from: "T0", to: "T1", role: "context: the post-adoption violation enters (a review here was skipped in the story)", registry: "registry-t0.json" },
  { id: "scenario-a", branch: "t2-late-touch", from: "T1", to: "T2", role: "post-adoption debt touched; it already exists at the diff base", registry: "registry-t0.json" },
  { id: "a-control", branch: "a-control", from: "T1", to: "A-control", role: "valid control after T1", registry: "registry-t0.json" },
  { id: "scenario-b", branch: "main", from: "T3", to: "T4", role: "superseded-rule touch plus current-rule violation", registry: "registry-t3.json" },
  { id: "b-control", branch: "b-control", from: "T3", to: "B-control", role: "valid control after supersession", registry: "registry-t3.json" },
];

// ---- DUO: adoption at T0 ----
git("checkout", "-q", "t0-adoption");
save("duo/init.json", duo(["init", "--non-interactive", "--answers", "-", "--json"], "[]").stdout);
const adoptionFile = fs.readdirSync(path.join(repo, ".duo-project", "reviews")).find((f) => f.startsWith("adoption-"));
const adoption = JSON.parse(fs.readFileSync(path.join(repo, ".duo-project", "reviews", adoptionFile), "utf8"));
save("duo/adoption-baseline.json", JSON.stringify(adoption, null, 2) + "\n");

const duoResults = {};
for (const s of SCENARIOS) {
  git("checkout", "-q", s.branch);
  save("duo/" + s.id + "/index.json", duo(["index", "--json"]).stdout);
  const hashes = [];
  let exitCode;
  for (let i = 1; i <= RUNS; i++) {
    const r = duo(["review", "--from", commits[s.from], "--to", commits[s.to], "--json"]);
    save("duo/" + s.id + "/review-" + String(i).padStart(2, "0") + ".json", r.stdout);
    const projection = canonicalReview(JSON.parse(r.stdout));
    hashes.push(sha256(projection));
    exitCode = r.code;
    if (i === 1) save("duo/" + s.id + "/canonical.json", JSON.stringify(projection, null, 2) + "\n");
  }
  save("duo/" + s.id + "/review-human.txt", duo(["review", "--from", commits[s.from], "--to", commits[s.to]]).stdout);
  const gate = duo(["review", "--from", commits[s.from], "--to", commits[s.to], "--fail-on", "block"]);
  save("duo/" + s.id + "/status.txt", duo(["status"]).stdout);
  const first = JSON.parse(fs.readFileSync(path.join(OUT, "duo", s.id, "review-01.json"), "utf8")).result;
  duoResults[s.id] = {
    range: s.from + ".." + s.to, verdict: first.verdict,
    claims: first.claims.map((c) => ({ decision: c.subject.id, rule: c.rule, reason: c.reason, provenance: c.provenance ?? null, blockEligible: c.blockEligible, observed: c.observed })),
    gaps: (first.gaps?.gaps ?? []).map((g) => g.kind), baseline: first.baseline,
    runs: hashes.length, identical: new Set(hashes).size === 1, canonicalHash: hashes[0], exitCodeDefault: exitCode, exitCodeFailOnBlock: gate.code,
  };
}
// Lifecycle as the public read surface shows it at T4 (main): the SUPERSEDES edge in both directions.
git("checkout", "-q", "main");
duo(["index"]);
const traces = {};
for (const id of ["D-001", "D-002"]) {
  const t = duo(["trace", id, "--json"]);
  save("duo/trace-" + id + ".json", t.stdout);
  traces[id] = JSON.parse(t.stdout).result.edges;
}

// ---- DIY-0 / DIY-1 / DIY-2 ----
const diy0 = path.join(here, "..", "decision-compliance", "diy", "session-store-gate.mjs");
const diy1 = path.join(here, "diy", "adoption-gate.mjs");
const diy2 = path.join(here, "diy", "decision-gate.mjs");
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
const state1 = path.join(state, "adoption.json");
const state2 = path.join(state, "decision-adoption.json");
node(diy1, ["adopt", "--at", commits.T0, "--state", state1]);
node(diy2, ["adopt", "--at", commits.T0, "--registry", path.join(here, "diy", "registry-t0.json"), "--state", state2]);
save("diy-1/adoption-state.json", fs.readFileSync(state1, "utf8"));
save("diy-2/adoption-state.json", fs.readFileSync(state2, "utf8"));
const diyResults = { "diy-0": {}, "diy-1": {}, "diy-2": {} };
for (const s of SCENARIOS) {
  const variantsOf = {
    "diy-0": () => node(diy0, ["--base", commits[s.from], "--head", commits[s.to]]),
    "diy-1": () => node(diy1, ["check", "--base", commits[s.from], "--head", commits[s.to], "--state", state1]),
    "diy-2": () => node(diy2, ["check", "--base", commits[s.from], "--head", commits[s.to], "--registry", path.join(here, "diy", s.registry), "--state", state2]),
  };
  for (const [name, run] of Object.entries(variantsOf)) {
    const outs = [];
    let code;
    for (let i = 1; i <= RUNS; i++) { const p = run(); outs.push(p.stdout); code = p.status; }
    save(name + "/" + s.id + ".json", outs[0]);
    const first = JSON.parse(outs[0]);
    diyResults[name][s.id] = { verdict: first.verdict, findings: first.findings, runs: outs.length, identical: new Set(outs).size === 1, exitCode: code };
  }
}
const cost = (file) => { const l = fs.readFileSync(file, "utf8").split("\n"); return { lines: l.length, codeLines: l.filter((x) => x.trim() !== "" && !x.trim().startsWith("//") && !x.startsWith("#!")).length }; };
const lines = (f) => fs.readFileSync(f, "utf8").trimEnd().split("\n").length;
const diyCost = {
  "diy-0": { files: 1, ...cost(diy0), state: "none" },
  "diy-1": { files: 1, ...cost(diy1), state: "adoption state JSON (" + lines(state1) + " lines, generated once at adoption)" },
  "diy-2": { files: 1, ...cost(diy2), state: "registry JSON edited by people (" + lines(path.join(here, "diy", "registry-t0.json")) + " lines at T0, " + lines(path.join(here, "diy", "registry-t3.json")) + " lines after the supersession) + adoption state JSON (" + lines(state2) + " lines)" },
};

const summary = {
  format: "duo-bench.decision-compliance/1", benchmark: "decision-compliance-02", fixture: FIXTURE_VERSION, policies: { "D-001": POLICY_D001, "D-002": POLICY_D002 },
  commits, timeline: TIMELINE.map((s) => ({ step: s.step, branch: s.branch, parent: s.parent, message: s.message, files: Object.keys(s.files) })), roles: ROLES,
  scenarios: SCENARIOS, environment, subject, runsPerScenario: RUNS,
  duo: { adoption: { baselineId: adoption.id, commit: adoption.git?.headOid ?? null, findings: adoption.findings.map((f) => ({ governing: f.governing, offending: f.offending })) }, traceAtT4: traces, ...duoResults },
  diy: { cost: diyCost, ...diyResults },
};
save("summary.json", JSON.stringify(summary, null, 2) + "\n");
save("environment.json", JSON.stringify({ environment, subject }, null, 2) + "\n");
console.log(JSON.stringify({ duo: Object.fromEntries(Object.entries(duoResults).map(([k, v]) => [k, [v.verdict, v.identical, v.claims.map((c) => c.decision + ":" + c.provenance)]])),
  diy: Object.fromEntries(Object.entries(diyResults).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, r]) => [s, r.verdict]))])) }, null, 1));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
