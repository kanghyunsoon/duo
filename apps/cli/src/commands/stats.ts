/** duoctl stats (T15): a summary of runtime/metrics.jsonl. Read-only. */
import { readRuntimeMetrics } from "@duo-director/director";
import { t } from "../messages.js";
import { EXIT, type Outcome } from "../output.js";
import { requireProject, usage, type Env } from "./shared.js";

export function statsCommand(env: Env, lastArg: string | undefined): Outcome {
  const project = requireProject(env, "stats");
  if (project.value === undefined) return project.outcome as Outcome;
  const last = lastArg === undefined ? undefined : Number(lastArg);
  if (last !== undefined && (!Number.isInteger(last) || last < 1)) return usage("stats", "--last must be a positive integer");
  const metrics = readRuntimeMetrics(env.root, last === undefined ? {} : { last });
  const contexts = metrics.filter((m) => m.command === "context" && m.contextTokens !== undefined);
  const reviews = metrics.filter((m) => m.command === "review" && m.reviewVerdict !== undefined);
  const verdicts = Object.fromEntries(["PASS", "WARN", "BLOCK", "ASK"].map((v) => [v, reviews.filter((r) => r.reviewVerdict === v).length]));
  const avg = contexts.length === 0 ? 0 : Math.round(contexts.reduce((n, m) => n + (m.contextTokens ?? 0), 0) / contexts.length);
  const llmCalls = metrics.reduce((n, m) => n + (m.llmCalls ?? 0), 0);
  const result = { entries: metrics.length, context: { requests: contexts.length, averageTokens: avg, estimator: "o200k_base" }, review: { runs: reviews.length, verdicts }, llm: { calls: llmCalls } };
  const human = metrics.length === 0 ? [t(env.locale, "stats.none")] : [
    `context  ${contexts.length} requests · avg loaded ${avg} · estimator o200k_base`,
    `review   ${reviews.length} runs · PASS ${verdicts.PASS} · WARN ${verdicts.WARN} · BLOCK ${verdicts.BLOCK} · ASK ${verdicts.ASK}`,
    `llm      calls ${llmCalls}`,
  ];
  return { command: "stats", exitCode: EXIT.OK, diagnostics: [], human, result };
}
