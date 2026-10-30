#!/usr/bin/env node
/**
 * Issue #34 ([AGT-02]): Local, LLM-free concurrency stress runner for DUO.
 *
 * Executes Scenarios C1 through C5 against temporary repositories, compares each concurrent run
 * against a sequential baseline using `bench/concurrency/oracle.mjs`, cleans up all temporary
 * repositories/worktrees on all three OSes, and prints a structured findings report.
 *
 * Usage:
 *   node bench/concurrency/run.mjs [--json] [--output <path>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  runScenarioConcurrentContextAndReview,
  runScenarioConcurrentDecisionProposals,
  runScenarioConcurrentGitWorktrees,
  runScenarioConcurrentGraphIndex,
  runScenarioConcurrentWorkMapActivity,
} from "./oracle.mjs";

export async function runAllConcurrencyScenarios() {
  const specs = [
    {
      id: "C1",
      description: "6 agents concurrently proposing Decisions (DecisionService.propose)",
      run: () => runScenarioConcurrentDecisionProposals({ workerCount: 6 }),
    },
    {
      id: "C2a",
      description: "4 workers concurrently indexing a cold repository (indexRepository)",
      run: () => runScenarioConcurrentGraphIndex({ workerCount: 4, preIndex: false }),
    },
    {
      id: "C2b",
      description: "4 workers concurrently running incremental index after source edit",
      run: () => runScenarioConcurrentGraphIndex({ workerCount: 4, preIndex: true }),
    },
    {
      id: "C3",
      description: "6 agents concurrently calling projectContext and projectReview on active diff",
      run: () => runScenarioConcurrentContextAndReview({ workerCount: 6 }),
    },
    {
      id: "C4",
      description: "6 MCP sessions concurrently updating Work-Map activity (work-tasks.lock)",
      run: () => runScenarioConcurrentWorkMapActivity({ workerCount: 6 }),
    },
    {
      id: "C5",
      description: "2 agents concurrently indexing, proposing, and compiling context in Git worktrees",
      run: () => runScenarioConcurrentGitWorktrees(),
    },
  ];

  const results = [];
  for (const spec of specs) {
    const start = performance.now();
    const outcome = await spec.run();
    const durationMs = Math.round(performance.now() - start);
    results.push({
      id: spec.id,
      description: spec.description,
      durationMs,
      ...outcome,
    });
  }

  const summary = {
    totalScenarios: results.length,
    safeCount: results.filter((r) => r.classification === "safe").length,
    explicitErrorCount: results.filter((r) => r.classification === "explicit-error").length,
    silentInconsistencyCount: results.filter((r) => r.classification === "silent-inconsistency").length,
  };

  return {
    format: "duo.concurrency-stress/1",
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
    summary,
    results,
  };
}

export function formatConcurrencyMarkdownTable(report) {
  const lines = [
    "# Issue #34 (`[AGT-02]`) Multi-Agent Concurrency Stress Report",
    "",
    `- **Environment**: \`${report.environment.platform} (${report.environment.arch})\`, Node \`${report.environment.nodeVersion}\``,
    `- **Summary**: **${report.summary.safeCount}** \`safe\`, **${report.summary.explicitErrorCount}** \`explicit-error\`, **${report.summary.silentInconsistencyCount}** \`silent-inconsistency\``,
    "",
    "| ID | Scenario | Workers | Succeeded | Failed | Classification | Explicit Diagnostic Codes | Baseline Equivalence | Duration (ms) |",
    "| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :---: | ---: |",
  ];

  for (const r of report.results) {
    const codes = r.explicitErrorCodes.length > 0 ? `\`${r.explicitErrorCodes.join("`, `")}\`` : "—";
    const eq =
      r.silentReasons.length === 0
        ? "100% match"
        : `MISMATCH (${r.silentReasons.join("; ")})`;
    lines.push(
      `| **${r.id}** | ${r.description} | ${r.totalWorkers} | ${r.succeededCount} | ${r.failedCount} | \`${r.classification}\` | ${codes} | ${eq} | ${r.durationMs} |`,
    );
  }
  return lines.join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const outIdx = args.indexOf("--output");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  const report = await runAllConcurrencyScenarios();
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatConcurrencyMarkdownTable(report));
  }

  if (report.summary.silentInconsistencyCount > 0) {
    process.exitCode = 1;
  }
}
