#!/usr/bin/env node
// Decision Compliance Benchmark 2: external AI review runs (manual; never part of CI). Generates the same timeline and
// runs the tool N times on one scenario commit; stores the review output with machine-specific paths replaced.
// The reviewer reads the repository's native decision docs: AGENTS.md (current policy map), docs/decisions/ (history),
// docs/adoption.md (adoption commit and known legacy debt).
//   node bench/decision-compliance-02/external.mjs --tool codex --scenario scenario-a|scenario-b|a-control|b-control [--runs 5] [--model gpt-5.5]
// Codex: `codex review --commit <scenario commit>` reviews that commit against its parent (the command does not accept
// custom instructions together with --commit). The scenario commit is checked out first, as in a pull-request review,
// so the working-tree decision docs are the ones of the reviewed commit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
const TARGET = { "scenario-a": "T2", "scenario-b": "T4", "a-control": "A-control", "b-control": "B-control" };
const BRANCH = { "scenario-a": "t2-late-touch", "scenario-b": "main", "a-control": "a-control", "b-control": "b-control" };
const tool = arg("tool");
const scenario = arg("scenario");
const RUNS = Number(arg("runs", "5"));
const MODEL = arg("model", "gpt-5.5");
if (tool !== "codex" || TARGET[scenario] === undefined) { console.error("usage: --tool codex --scenario " + Object.keys(TARGET).join("|")); process.exit(2); }
const OUT = path.join(here, "evidence", tool, scenario);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc02-ext-")));
const repo = path.join(tmp, "repo");
const commits = generateFixture(repo);
const target = commits[TARGET[scenario]];
spawnSync("git", ["checkout", "-q", BRANCH[scenario]], { cwd: repo, windowsHide: true });
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).stdout.trim();
if (head !== target) throw new Error("checkout failed: HEAD " + head + ", expected " + target);
const variants = (p) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\")];
const pairs = [...variants(repo).map((v) => [v, "<fixture>"]), ...variants(tmp).map((v) => [v, "<tmp>"]), ...variants(os.homedir()).map((v) => [v, "<home>"])];
const scrub = (t) => pairs.reduce((s, [a, b]) => s.split(a).join(b), String(t));
fs.mkdirSync(OUT, { recursive: true });

const runs = [];
for (let i = 1; i <= RUNS; i++) {
  const started = Date.now();
  const p = spawnSync("codex", ["review", "--commit", target, "-c", "model=" + MODEL], { cwd: repo, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const header = Object.fromEntries((p.stderr.match(/^(OpenAI Codex v\S+|model: .*|provider: .*|approval: .*|sandbox: .*)$/gmu) ?? []).map((l) => l.startsWith("OpenAI") ? ["client", l] : l.split(/: (.*)/u).slice(0, 2)));
  fs.writeFileSync(path.join(OUT, "run-" + String(i).padStart(2, "0") + ".txt"), scrub(p.stdout));
  runs.push({ run: i, exitCode: p.status, seconds: Math.round((Date.now() - started) / 1000), ...header });
  console.error(tool + " " + scenario + " run " + i + ": exit " + p.status);
}
fs.writeFileSync(path.join(OUT, "runs.json"), scrub(JSON.stringify({ tool, scenario, date: new Date().toISOString(), checkedOut: BRANCH[scenario], command: "codex review --commit " + target + " -c model=" + MODEL, commits, runs }, null, 2)) + "\n");
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
