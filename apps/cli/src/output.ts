/**
 * CLI result contract (T15). Every command returns an Outcome: a machine-readable envelope
 * (--json: { format: "duo.cli.<command>/1", command, ok, exitCode, result, diagnostics }) and
 * human lines rendered from the same result. Domain results are passed through unchanged; the human
 * renderer never feeds the JSON. Exit codes separate operational failure from Review verdicts:
 * a verdict fails the process only with --fail-on (or --strict).
 */
import type { Diagnostic } from "@duo-director/core";
import type { RuntimeMetric } from "@duo-director/director";

export const EXIT = {
  OK: 0,
  /** Operational failure, invalid usage, a terminal required but missing. */
  ERROR: 1,
  /** review --fail-on warn (or --strict) and the verdict is WARN. */
  WARN: 2,
  /** review --fail-on ask|warn and the verdict is ASK. */
  ASK: 3,
  /** review --fail-on block|ask|warn and the verdict is BLOCK. */
  BLOCK: 4,
  /** No .duo-project/project.yaml. */
  NOT_INITIALIZED: 5,
  /** The command could not finish without an action: index required, adoption policy required, repository to clean. */
  ACTION_REQUIRED: 6,
} as const;

export type MetricFields = Omit<RuntimeMetric, "format" | "command" | "exitCode" | "durationMs" | "at">;

export interface Outcome {
  readonly command: string;
  readonly exitCode: number;
  readonly result: unknown;
  readonly diagnostics: readonly Diagnostic[];
  /** Human output (already localized). */
  readonly human: readonly string[];
  /** Fields for runtime/metrics.jsonl; absent for read-only commands (status, trace, impact, stats). */
  readonly metric?: MetricFields;
}

export function envelope(o: Outcome, extra: readonly Diagnostic[] = []): Record<string, unknown> {
  return {
    format: `duo.cli.${o.command}/1`, command: o.command, ok: o.exitCode === EXIT.OK, exitCode: o.exitCode,
    result: o.result, diagnostics: [...o.diagnostics, ...extra],
  };
}

export function failed(command: string, exitCode: number, diagnostics: readonly Diagnostic[], human: readonly string[], result: unknown = null, metric?: MetricFields): Outcome {
  return { command, exitCode, result, diagnostics, human, ...(metric === undefined ? {} : { metric }) };
}
