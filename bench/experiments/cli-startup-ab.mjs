// Paired startup comparison for two packed duoctl entries.
// Usage: node bench/experiments/cli-startup-ab.mjs --a <duoctl.js> --b <duoctl.js> [--command version|help|status] [--rounds 5] [--runs 3]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const local = path.join(workspace, "bench", "results", "local");
const root = path.join(local, "fixtures", "small");
const value = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const integer = (name, fallback) => Number.parseInt(value(name) ?? String(fallback), 10);
const fail = (message) => { process.stderr.write(`cli-startup-ab: ${message}\n`); process.exit(2); };
const entries = { A: value("--a"), B: value("--b") };
const command = value("--command") ?? "status";
const rounds = integer("--rounds", 5);
const runs = integer("--runs", 3);
if (entries.A === undefined || entries.B === undefined) fail("--a and --b are required");
for (const name of ["A", "B"]) {
  entries[name] = path.resolve(workspace, entries[name]);
  if (!fs.existsSync(entries[name])) fail(`${name} entry not found: ${entries[name]}`);
}
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(runs) || runs < 1) fail("--rounds and --runs must be positive integers");
if (!["version", "help", "status"].includes(command)) fail("--command must be version, help, or status");
if (!fs.existsSync(path.join(root, ".duo-project", "generated", "graph.db"))) fail("run pnpm benchmark:smoke first");

const env = { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", DUO_LOCALE: "" };
function sample(entry) {
  const args = command === "version" ? ["--version"] : command === "help" ? ["--help"] : ["status", "--root", root, "--json"];
  const started = performance.now();
  const child = spawnSync(process.execPath, [entry, ...args], {
    cwd: root, env, encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const output = command === "status" ? JSON.parse(child.stdout) : child.stdout.replaceAll("\r\n", "\n");
  return { wallMs, output };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = { format: "duo.cli-startup-ab/1", platform: process.platform, node: process.version, command, rounds: [] };
for (let round = 1; round <= rounds; round += 1) {
  const order = round % 2 === 1 ? ["A", "B"] : ["B", "A"];
  const row = { round, order };
  for (const name of order) {
    sample(entries[name]); // Unmeasured warm-up; the gate compares three warm process starts per build.
    const samples = Array.from({ length: runs }, () => sample(entries[name]));
    row[name] = { samplesMs: samples.map((item) => item.wallMs), medianMs: median(samples.map((item) => item.wallMs)) };
    const normalized = samples.map((item) => JSON.stringify(item.output));
    if (normalized.some((item) => item !== normalized[0])) throw new Error(`${name} output changed within round ${round}`);
    row[`${name}Output`] = normalized[0];
  }
  if (row.AOutput !== row.BOutput) throw new Error(`A/B output differs in round ${round}`);
  row.deltaMs = row.A.medianMs - row.B.medianMs;
  delete row.AOutput;
  delete row.BOutput;
  result.rounds.push(row);
  console.log(`round ${round} ${order.join("→")}: A ${row.A.medianMs.toFixed(1)} ms, B ${row.B.medianMs.toFixed(1)} ms, delta ${row.deltaMs.toFixed(1)} ms`);
}
const deltas = result.rounds.map((row) => row.deltaMs);
result.summary = { wins: deltas.filter((delta) => delta > 0).length, medianDeltaMs: median(deltas), requiredWins: Math.ceil(rounds * 0.8), requiredMedianDeltaMs: 50 };
result.summary.passed = result.summary.wins >= result.summary.requiredWins && result.summary.medianDeltaMs >= result.summary.requiredMedianDeltaMs;
fs.writeFileSync(path.join(local, `cli-startup-ab-${command}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.summary));
