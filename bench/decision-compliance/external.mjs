#!/usr/bin/env node
// Decision Compliance Benchmark 1: external AI review runs (manual; never part of CI). Generates the same fixture,
// runs the tool N times on the change commit and stores the review output with machine-specific paths replaced.
// The policy reaches the tool only through its native instruction file in the fixture (AGENTS.md / CLAUDE.md).
//   node bench/decision-compliance/external.mjs --tool codex [--scenario change|control-only] [--runs 5] [--model gpt-5.5]
// Codex: `codex review --commit <change>` (the command does not accept custom instructions together with --commit).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : process.argv[i + 1]; };
const tool = arg("tool");
const RUNS = Number(arg("runs", "5"));
const MODEL = arg("model", "gpt-5.5");
const SCENARIO = arg("scenario", "change");
if (tool !== "codex") { console.error("usage: --tool codex (other tools: see docs/benchmarks/decision-compliance-01.md)"); process.exit(2); }
if (!["change", "control-only"].includes(SCENARIO)) { console.error("--scenario change|control-only"); process.exit(2); }
const OUT = path.join(here, "evidence", tool, SCENARIO);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-dc01-ext-")));
const repo = path.join(tmp, "repo");
const commits = generateFixture(repo);
const target = SCENARIO === "change" ? commits.change : commits.controlOnly;
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
  console.error(tool + " run " + i + ": exit " + p.status);
}
fs.writeFileSync(path.join(OUT, "runs.json"), scrub(JSON.stringify({ tool, scenario: SCENARIO, date: new Date().toISOString(), command: "codex review --commit " + target + " -c model=" + MODEL, commits, runs }, null, 2)) + "\n");
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
