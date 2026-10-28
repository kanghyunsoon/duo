import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * #107: every stage of the MCP benchmark is bounded. #126: each case runs one scenario (single-cold) against the
 * unresponsive fake server, so it starts one server and waits for one 500 ms stage timeout instead of running all
 * four scenarios. The stage timeout under test stays 500 ms. The outer limit only stops a hung benchmark.
 */
const BENCH = path.resolve("bench/mcp.mjs");
const FAKE = path.resolve("tests/bench/fixtures/unresponsive-mcp.mjs");
const OUTER_LIMIT_MS = 15_000;

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Everything needed to tell a stage timeout from a crash, an outer timeout or a signal when an assertion fails. */
function describeRun(result: SpawnSyncReturns<string>, ms: number): string {
  return [
    `status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? "none"} wall=${Math.round(ms)}ms`,
    `stdout(${result.stdout?.length ?? 0} chars)=${(result.stdout ?? "").slice(0, 400)}`,
    `stderr=${(result.stderr ?? "").slice(-1_500)}`,
  ].join("\n");
}

function runBenchmark(args: string[], env: NodeJS.ProcessEnv = {}): { result: SpawnSyncReturns<string>; ms: number } {
  const started = performance.now();
  const result = spawnSync(process.execPath, [BENCH, ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: OUTER_LIMIT_MS,
    windowsHide: true,
  });
  return { result, ms: performance.now() - started };
}

describe("MCP benchmark timeouts", () => {
  it.each([
    ["initialize", "initialize"],
    ["tools/list", "tools/list"],
    ["tools/call", "duo_get_context"],
  ])("reports a %s timeout, exits non-zero, and cleans up the server", (mode, stage) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-timeout-test-"));
    const pidFile = path.join(temp, "pids.txt");
    try {
      const { result, ms } = runBenchmark(["--scenario", "single-cold", "--iterations", "1", "--concurrency", "1", "--timeout-ms", "500"], {
        DUO_MCP_BENCHMARK_FAKE_MODE: mode,
        DUO_MCP_BENCHMARK_PID_FILE: pidFile,
        DUO_MCP_BENCHMARK_SERVER_SCRIPT: FAKE,
      });
      const why = describeRun(result, ms);
      // Not the outer limit, not a signal, not an internal benchmark failure (exit 2): the report's stage errors (exit 1).
      expect(result.error, why).toBeUndefined();
      expect(result.signal, why).toBeNull();
      expect(result.status, why).toBe(1);
      expect(result.stdout.trim(), why).not.toBe("");
      const report = JSON.parse(result.stdout) as { configuration: { scenario?: string; timeoutMs: number }; scenarios: Record<string, { errors: Array<{ stage: string; kind: string }> }> };
      expect(report.configuration, why).toMatchObject({ scenario: "single-cold", timeoutMs: 500 });
      expect(Object.keys(report.scenarios), why).toEqual(["single-cold"]);
      expect(Object.values(report.scenarios).flatMap((scenario) => scenario.errors), why).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage, kind: "timeout" })]),
      );
      const pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.length, why).toBeGreaterThan(0);
      expect(pids.filter(processIsRunning), why).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, OUTER_LIMIT_MS + 5_000);

  it("rejects an unknown --scenario as a benchmark failure (exit 2), not a stage timeout", () => {
    const { result, ms } = runBenchmark(["--scenario", "no-such-scenario"], { DUO_MCP_BENCHMARK_SERVER_SCRIPT: FAKE });
    const why = describeRun(result, ms);
    expect(result.status, why).toBe(2);
    expect(result.stdout, why).toBe("");
    expect(result.stderr, why).toContain("--scenario must be one of single-cold, single-warm, concurrent-cold, concurrent-warm");
  }, OUTER_LIMIT_MS + 5_000);
});
