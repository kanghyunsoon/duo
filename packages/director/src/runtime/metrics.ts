/**
 * Local runtime metrics (T15, C83): .duo-project/runtime/metrics.jsonl, one JSON object per line,
 * appended by the CLI (and later MCP) after a command. A local observation, not history: it is
 * ignored by Git and never a Review Record. Only structured fields: no secrets, source text, diff
 * text or task text. Nothing is written for a repository that is not initialized.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createDiagnostic, failure, guardWrite, PROJECT_FILE_NAME, STATE_DIR_NAME, success, type ParseResult } from "@duo-director/core";

export const METRICS_PATH = `${STATE_DIR_NAME}/runtime/metrics.jsonl`;

export interface RuntimeMetric {
  readonly format: "duo.metric/1";
  readonly command: string;
  /** Outcome of the command (ok, index-required, failed, …). */
  readonly status: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** Injectable clock; not an identity. */
  readonly at: string;
  readonly indexMode?: "full" | "incremental";
  readonly fullRebuildReason?: string;
  readonly contextStatus?: string;
  readonly contextTokens?: number;
  readonly contextBudget?: number;
  readonly reviewVerdict?: string;
  readonly reviewClaims?: number;
  readonly llmCalls?: number;
}

/** Appends one metric. "skipped" when the repository is not initialized; a boundary violation is an error. */
export async function appendRuntimeMetric(root: string, metric: RuntimeMetric): Promise<ParseResult<"written" | "skipped">> {
  if (!fs.existsSync(path.join(root, STATE_DIR_NAME, PROJECT_FILE_NAME))) return success("skipped");
  const guarded = guardWrite(root, METRICS_PATH, "regenerable");
  if (guarded.value === undefined) return failure(guarded.diagnostics);
  try {
    await fsp.mkdir(path.dirname(guarded.value.absolute), { recursive: true });
    await fsp.appendFile(guarded.value.absolute, `${JSON.stringify(metric)}\n`, "utf8");
    return success("written");
  } catch (error) {
    return failure([createDiagnostic("METRICS_WRITE_FAILED", `Cannot append ${METRICS_PATH}: ${(error as Error).message}`, { path: METRICS_PATH })]);
  }
}

/** The last metrics (newest last). Lines that are not valid metrics are skipped. Read-only. */
export function readRuntimeMetrics(root: string, options: { readonly last?: number } = {}): RuntimeMetric[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, METRICS_PATH), "utf8");
  } catch {
    return [];
  }
  const out: RuntimeMetric[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const m = JSON.parse(line) as RuntimeMetric;
      if (m.format === "duo.metric/1" && typeof m.command === "string") out.push(m);
    } catch {
      // a torn or foreign line: skipped
    }
  }
  return options.last === undefined ? out : out.slice(-options.last);
}
