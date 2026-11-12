// Paired MCP initialize comparison for two packed duoctl entries.
// Usage: node bench/experiments/mcp-startup-ab.mjs --a <duoctl.js> --b <duoctl.js> [--rounds 5] [--iterations 3]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const local = path.join(workspace, "bench", "results", "local");
const benchmark = path.join(workspace, "bench", "mcp.mjs");
const value = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const integer = (name, fallback) => Number.parseInt(value(name) ?? String(fallback), 10);
const fail = (message) => { process.stderr.write(`mcp-startup-ab: ${message}\n`); process.exit(2); };
const entries = { A: value("--a"), B: value("--b") };
const rounds = integer("--rounds", 5);
const iterations = integer("--iterations", 3);
if (entries.A === undefined || entries.B === undefined) fail("--a and --b are required");
for (const name of ["A", "B"]) {
  entries[name] = path.resolve(workspace, entries[name]);
  if (!fs.existsSync(entries[name])) fail(`${name} entry not found: ${entries[name]}`);
}
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(iterations) || iterations < 1) fail("--rounds and --iterations must be positive integers");

function measure(entry, count) {
  const child = spawnSync(process.execPath, [benchmark, "--cli", entry, "--scenario", "single-cold", "--iterations", String(count), "--concurrency", "1"], {
    cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000,
  });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || `benchmark exited ${child.status}`);
  const report = JSON.parse(child.stdout);
  const scenario = report.scenarios?.["single-cold"];
  if (report.toolContract?.verified !== true || scenario?.errorCount !== 0) throw new Error("MCP contract or tool call failed");
  if (scenario.latency?.initialize?.count !== count) throw new Error(`expected ${count} initialize samples`);
  return report;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = {
  format: "duo.mcp-startup-ab/1", platform: process.platform, node: process.version, rounds: [],
  configuration: { rounds, iterations, scenario: "single-cold", warmupIterations: 1 },
};

const warmups = { A: measure(entries.A, 1), B: measure(entries.B, 1) };
if (JSON.stringify(warmups.A.toolContract) !== JSON.stringify(warmups.B.toolContract)) throw new Error("A/B MCP tool contract differs during warm-up");

for (let round = 1; round <= rounds; round += 1) {
  const order = round % 2 === 1 ? ["A", "B"] : ["B", "A"];
  const row = { round, order };
  for (const name of order) row[name] = measure(entries[name], iterations);
  if (JSON.stringify(row.A.toolContract) !== JSON.stringify(row.B.toolContract)) throw new Error(`A/B MCP tool contract differs in round ${round}`);
  const a = row.A.scenarios["single-cold"].latency.initialize.p50Ms;
  const b = row.B.scenarios["single-cold"].latency.initialize.p50Ms;
  row.initialize = { AMedianMs: a, BMedianMs: b, deltaMs: a - b };
  result.rounds.push(row);
  console.log(`round ${round} ${order.join("→")}: A ${a.toFixed(1)} ms, B ${b.toFixed(1)} ms, delta ${(a - b).toFixed(1)} ms`);
}

const deltas = result.rounds.map((row) => row.initialize.deltaMs);
result.summary = {
  wins: deltas.filter((delta) => delta > 0).length,
  medianDeltaMs: median(deltas),
  requiredWins: Math.ceil(rounds * 0.8),
  requiredMedianDeltaMs: 50,
};
result.summary.passed = result.summary.wins >= result.summary.requiredWins && result.summary.medianDeltaMs >= result.summary.requiredMedianDeltaMs;
fs.writeFileSync(path.join(local, "mcp-startup-ab.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.summary));
