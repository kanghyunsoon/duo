#!/usr/bin/env node
/**
 * Issue #33 ([AGT-01]): CLI runner for No-LLM Decision Continuity verification across sessions and agents.
 *
 * Usage:
 *   node bench/decision-continuity/run.mjs [--json] [--output <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAllContinuityScenarios } from "./oracle.mjs";

function parseArgs(argv) {
  let json = false;
  let outputPath;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--output" && i + 1 < argv.length) {
      outputPath = argv[++i];
    }
  }
  return { json, outputPath };
}

export function formatMarkdownReport(report) {
  const lines = [
    "# DUO Decision Continuity Report (`[AGT-01]` — No-LLM Deterministic Verification)",
    "",
    `- **Total Scenarios**: ${report.summary.total}`,
    `- **Continuity Verified**: ${report.summary.verified}`,
    `- **Continuity Broken**: ${report.summary.broken}`,
    `- **Total Duration**: ${report.summary.totalDurationMs} ms`,
    "",
    "| Scenario | Description | Classification | Active Decisions | Superseded History | Pending Proposals | Compliant Verdict | Violating Verdict | Cited Decision | Duration (ms) |",
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: |",
  ];

  for (const r of report.results) {
    const active = r.activeIds.length > 0 ? r.activeIds.map((id) => `\`${id}\``).join(", ") : "none";
    const history = r.historyIds.length > 0 ? r.historyIds.map((id) => `\`${id}\``).join(", ") : "none";
    const pending = r.pendingIds.length > 0 ? r.pendingIds.map((id) => `\`${id}\``).join(", ") : "none";
    const cited = r.citedDecisionId ? `\`${r.citedDecisionId}\`` : "none";
    lines.push(
      `| **${r.scenarioId}** | ${r.description} | \`${r.classification}\` | ${active} | ${history} | ${pending} | \`${r.compliantVerdict}\` | \`${r.violatingVerdict}\` | ${cited} | ${r.durationMs} |`,
    );
  }

  const brokenScenarios = report.results.filter((r) => r.violations.length > 0);
  if (brokenScenarios.length > 0) {
    lines.push("", "## Violations", "");
    for (const r of brokenScenarios) {
      lines.push(`### ${r.scenarioId}`);
      for (const v of r.violations) {
        lines.push(`- ${v}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

export async function runCli(argv = process.argv.slice(2)) {
  const { json, outputPath } = parseArgs(argv);
  const startedAt = performance.now();
  const results = await runAllContinuityScenarios();
  const totalDurationMs = Math.round(performance.now() - startedAt);

  const verified = results.filter((r) => r.classification === "continuity-verified").length;
  const broken = results.filter((r) => r.classification === "continuity-broken").length;

  const report = {
    benchmark: "duo.decision-continuity/1",
    summary: {
      total: results.length,
      verified,
      broken,
      totalDurationMs,
    },
    results,
  };

  const rendered = json ? JSON.stringify(report, null, 2) + "\n" : formatMarkdownReport(report);

  if (outputPath !== undefined) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }

  if (broken > 0) {
    process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
