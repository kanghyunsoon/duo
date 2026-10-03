#!/usr/bin/env node
// Decision Compliance Benchmark 1 runner: published DUO and the DIY baseline on the generated fixture.
// DUO under test is always the npm registry package, installed into a temporary prefix with an empty npm config;
// no workspace code is used. Writes raw evidence (with machine-specific paths replaced) and a summary.
//   node bench/decision-compliance/run.mjs [--version 0.2.0] [--runs 10] [--evidence <dir>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReview, sha256 } from "./canonical.mjs";
import { FIXTURE_VERSION, POLICY, ROLES, generateFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
const VERSION = arg("version", "0.2.0");
const RUNS = Number(arg("runs", "10"));
const OUT = path.resolve(arg("evidence", path.join(here, "evidence")));
const REGISTRY = "https://registry.npmjs.org/";
const IS_WIN = process.platform === "win32";
const npmCmd = IS_WIN ? "npm.cmd" : "npm";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc01-")));
const prefix = path.join(tmp, "prefix");
const repo = path.join(tmp, "repo");
const userconfig = path.join(tmp, "npmrc");
fs.writeFileSync(userconfig, "");
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|NPM_|NODE_OPTIONS$)/u.test(k)));
const npm = (args) => spawnSync(npmCmd, [...args, "--userconfig", userconfig, "--cache", path.join(tmp, "cache"), "--registry", REGISTRY], { encoding: "utf8", env: npmEnv, shell: IS_WIN, windowsHide: true });

// Machine-specific strings never reach the evidence files.
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
const install = npm(["install", "-g", "@duo-director/cli@" + VERSION, "--prefix", prefix, "--no-audit", "--no-fund"]);
if (install.status !== 0) throw new Error("npm install failed: " + install.stderr);
const pkgDir = [path.join(prefix, "node_modules", "@duo-director", "cli"), path.join(prefix, "lib", "node_modules", "@duo-director", "cli")].find((d) => fs.existsSync(d));
const entry = path.join(pkgDir, "dist", "duoctl.js");
const duo = (args, input, cwd = repo) => {
  const p = spawnSync(process.execPath, [entry, ...args], { cwd, input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DUO_LOCALE: "en", NO_COLOR: "1" } });
  return { code: p.status, stdout: p.stdout, stderr: p.stderr };
};
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const subject = { package: "@duo-director/cli", version: registry.version, integrity: registry["dist.integrity"], shasum: registry["dist.shasum"],
  installedVersion: JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version, duoctlVersion: duo(["--version"], undefined, tmp).stdout.trim() };

// ---- fixture ----
const commits = generateFixture(repo);

// ---- DUO: adoption at the baseline, then the change and the control-only change ----
git("checkout", "-q", "baseline");
const init = duo(["init", "--non-interactive", "--answers", "-", "--json"], "[]");
save("duo/init.json", init.stdout);
const adoptionFile = fs.readdirSync(path.join(repo, ".duo-project", "reviews")).find((f) => f.startsWith("adoption-"));
const adoption = JSON.parse(fs.readFileSync(path.join(repo, ".duo-project", "reviews", adoptionFile), "utf8"));
save("duo/adoption-baseline.json", JSON.stringify(adoption, null, 2) + "\n");

const scenarios = [{ id: "change", branch: "main", to: commits.change }, { id: "control-only", branch: "control-only", to: commits.controlOnly }];
const duoResults = {};
for (const s of scenarios) {
  git("checkout", "-q", s.branch);
  const index = duo(["index", "--json"]);
  save("duo/" + s.id + "/index.json", index.stdout);
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = duo(["review", "--from", commits.baseline, "--to", s.to, "--json"]);
    save("duo/" + s.id + "/review-" + String(i).padStart(2, "0") + ".json", r.stdout);
    const env = JSON.parse(r.stdout);
    const projection = canonicalReview(env);
    runs.push({ run: i, exitCode: r.code, hash: sha256(projection) });
    if (i === 1) save("duo/" + s.id + "/canonical.json", JSON.stringify(projection, null, 2) + "\n");
  }
  const human = duo(["review", "--from", commits.baseline, "--to", s.to]);
  save("duo/" + s.id + "/review-human.txt", human.stdout);
  const gate = duo(["review", "--from", commits.baseline, "--to", s.to, "--fail-on", "block"]);
  const first = JSON.parse(fs.readFileSync(path.join(OUT, "duo", s.id, "review-01.json"), "utf8")).result;
  duoResults[s.id] = {
    verdict: first.verdict, claims: first.claims.map((c) => ({ subject: c.subject.id, reason: c.reason, provenance: c.provenance ?? null, blockEligible: c.blockEligible, observed: c.observed })),
    gaps: first.gaps.length, runs: runs.length, identical: new Set(runs.map((r) => r.hash)).size === 1, canonicalHash: runs[0].hash,
    exitCodeDefault: runs[0].exitCode, exitCodeFailOnBlock: gate.code,
  };
}

// ---- DIY baseline ----
const gateScript = path.join(here, "diy", "session-store-gate.mjs");
const diyResults = {};
for (const s of scenarios) {
  const outs = [];
  let code;
  for (let i = 1; i <= RUNS; i++) {
    const p = spawnSync(process.execPath, [gateScript, "--base", commits.baseline, "--head", s.to], { cwd: repo, encoding: "utf8", windowsHide: true });
    outs.push(p.stdout); code = p.status;
    if (i === 1) save("diy/" + s.id + ".json", p.stdout);
  }
  const first = JSON.parse(outs[0]);
  diyResults[s.id] = { verdict: first.verdict, findings: first.findings, runs: outs.length, identical: new Set(outs).size === 1, exitCode: code };
}
const gateSource = fs.readFileSync(gateScript, "utf8").split("\n");
const diyCost = { files: 1, lines: gateSource.length, codeLines: gateSource.filter((l) => l.trim() !== "" && !l.trim().startsWith("//") && !l.startsWith("#!")).length, dependencies: 0 };

const summary = {
  format: "duo-bench.decision-compliance/1", benchmark: "decision-compliance-01", fixture: FIXTURE_VERSION, policy: POLICY,
  commits, roles: ROLES, environment, subject, runsPerScenario: RUNS,
  duo: { adoption: { baselineId: adoption.id, findings: adoption.findings.map((f) => ({ governing: f.governing, offending: f.offending })) }, ...duoResults },
  diy: { cost: diyCost, ...diyResults },
};
save("summary.json", JSON.stringify(summary, null, 2) + "\n");
save("environment.json", JSON.stringify({ environment, subject }, null, 2) + "\n");
console.log(JSON.stringify({ commits, subject, duo: Object.fromEntries(Object.entries(duoResults).map(([k, v]) => [k, { verdict: v.verdict, identical: v.identical, claims: v.claims.map((c) => c.provenance) }])), diy: Object.fromEntries(Object.entries(diyResults).map(([k, v]) => [k, v.verdict])) }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
