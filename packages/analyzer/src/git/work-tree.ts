/**
 * The work-tree prefix of one root, asked once per operation (T25.1). The scanner and the Git provider both
 * check that the root is the top level of its Git work tree with the same query in the same directory
 * (`git rev-parse --show-prefix`). One freshness or index run makes a probe and hands it to both, so Git runs
 * once; each caller still turns the result into its own diagnostics. A probe is never shared between
 * operations: no process-wide cache, no time-based reuse, nothing from an earlier run.
 */
import path from "node:path";
import { runGit, type GitResult } from "./exec.js";

export interface WorkTreeProbe {
  /** path.resolve(root) of the probe; a caller with another root asks Git itself. */
  readonly rootDir: string;
  /** The prefix of rootDir in its work tree ("" at the top level), from one subprocess however often asked. */
  prefix(): Promise<GitResult<string>>;
}

/** `git rev-parse --show-prefix` in rootDir without the trailing newline. */
export async function workTreePrefix(rootDir: string): Promise<GitResult<string>> {
  const result = await runGit(rootDir, ["rev-parse", "--show-prefix"]);
  return result.ok ? { ok: true, value: result.value.replace(/\r?\n$/u, "") } : result;
}

export function probeWorkTree(root: string): WorkTreeProbe {
  const rootDir = path.resolve(root);
  let asked: Promise<GitResult<string>> | undefined;
  return { rootDir, prefix: () => (asked ??= workTreePrefix(rootDir)) };
}

/** The probe's answer when it is for rootDir, else a query of its own. */
export function prefixFor(rootDir: string, probe: WorkTreeProbe | undefined): Promise<GitResult<string>> {
  return probe !== undefined && probe.rootDir === rootDir ? probe.prefix() : workTreePrefix(rootDir);
}

