import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #107: every stage of the MCP benchmark is bounded. #126: each case runs one scenario (single-cold) against the
 * unresponsive fake server, so it starts one server and waits for one 500 ms stage timeout instead of running all
 * four scenarios. The stage timeout under test stays 500 ms. The outer limit only stops a hung benchmark.
 */
const BENCH = path.resolve("bench/mcp.mjs");
const FAKE = path.resolve("tests/bench/fixtures/unresponsive-mcp.mjs");
// node --import needs a URL: a Windows absolute path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const FAIL_RM = pathToFileURL(path.resolve("tests/bench/fixtures/fail-rm.mjs")).href;
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

function runBenchmark(args: string[], env: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []): { result: SpawnSyncReturns<string>; ms: number } {
  const started = performance.now();
  const result = spawnSync(process.execPath, [...nodeArgs, BENCH, ...args], {
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
      const report = JSON.parse(result.stdout) as { configuration: { scenario?: string; timeoutMs: number }; scenarios: Record<string, { errors: Array<{ stage: string; kind: string }>; latency: Record<string, unknown> }> };
      expect(report.configuration, why).toMatchObject({ scenario: "single-cold", timeoutMs: 500 });
      expect(Object.keys(report.scenarios), why).toEqual(["single-cold"]);
      expect(Object.values(report.scenarios).flatMap((scenario) => scenario.errors), why).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage, kind: "timeout" })]),
      );
      if (mode === "tools/call") {
        expect(Object.keys(report.scenarios["single-cold"]?.latency ?? {}), why).toEqual(expect.arrayContaining(["duo_get_decision", "duo_trace"]));
      }
      const pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.length, why).toBeGreaterThan(0);
      // Each server is recorded twice: by the fake server itself and by the benchmark client. The client copy must be
      // there even when the handshake fails, because the benchmark uses that PID to wait for the server to exit.
      expect(pids.length, why).toBe(new Set(pids).size * 2);
      expect(pids.filter(processIsRunning), why).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, OUTER_LIMIT_MS + 5_000);

  // #126: a temp directory that cannot be removed is a benchmark failure (exit 2), but the finished report is kept on
  // stdout. TEMP/TMP/TMPDIR point the benchmark at a directory of this test, so a leftover copy is found and removed.
  it.each([
    ["every stage answered", false, 0, ""],
    ["every stage answered", true, 2, ""],
    ["a tools/call timeout", true, 2, "tools/call"],
  ] as const)("writes the report for %s (removal fails: %s) and exits %i", async (_label, failRemoval, status, mode) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-cleanup-test-"));
    const pidFile = path.join(temp, "pids.txt");
    const tmp = path.join(temp, "tmp");
    fs.mkdirSync(tmp);
    try {
      const { result, ms } = runBenchmark(["--scenario", "single-cold", "--iterations", "1", "--concurrency", "1", "--timeout-ms", "500"], {
        DUO_MCP_BENCHMARK_FAKE_MODE: mode,
        DUO_MCP_BENCHMARK_PID_FILE: pidFile,
        DUO_MCP_BENCHMARK_SERVER_SCRIPT: FAKE,
        TEMP: tmp,
        TMP: tmp,
        TMPDIR: tmp,
      }, failRemoval ? ["--import", FAIL_RM] : []);
      const why = describeRun(result, ms);
      expect(result.error, why).toBeUndefined();
      expect(result.signal, why).toBeNull();
      expect(result.status, why).toBe(status);
      const report = JSON.parse(result.stdout) as { scenarios: Record<string, { errors: Array<{ stage: string; kind: string }> }> };
      expect(Object.keys(report.scenarios), why).toEqual(["single-cold"]);
      const errors = report.scenarios["single-cold"]?.errors ?? [];
      if (mode === "tools/call") {
        expect(errors, why).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "duo_get_context", kind: "timeout" })]));
      } else {
        expect(errors, why).toEqual([]);
      }
      const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith("duo-mcp-benchmark-")).map((name) => path.join(tmp, name));
      if (failRemoval) {
        expect(leftovers, why).toHaveLength(1);
        expect(result.stderr, why).toContain(`mcp-benchmark: could not remove ${leftovers[0]}`);
      } else {
        expect(leftovers, why).toEqual([]);
        expect(result.stderr, why).not.toContain("could not remove");
      }
      const pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.length, why).toBeGreaterThan(0);
      expect(pids.filter(processIsRunning), why).toEqual([]);
    } finally {
      // fs.rmSync fails at once with EPERM on Windows while a just-killed server still holds the leftover copy.
      await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, OUTER_LIMIT_MS + 5_000);

  it.each([
    ["an unknown --scenario", ["--scenario", "no-such-scenario"], 'got "no-such-scenario"'],
    ["--scenario without a value", ["--scenario"], "got no value"],
  ])("rejects %s as a benchmark failure (exit 2), not a stage timeout", (_label, args, detail) => {
    const { result, ms } = runBenchmark(args, { DUO_MCP_BENCHMARK_SERVER_SCRIPT: FAKE });
    const why = describeRun(result, ms);
    expect(result.status, why).toBe(2);
    expect(result.stdout, why).toBe("");
    expect(result.stderr, why).toContain("--scenario must be one of single-cold, single-warm, concurrent-cold, concurrent-warm");
    expect(result.stderr, why).toContain(detail);
  }, OUTER_LIMIT_MS + 5_000);

  it.each([
    ["initialize", "its directory does not exist", (temp: string) => path.join(temp, "missing", "pids.txt")],
    ["tools/list", "it is a directory", (temp: string) => {
      const dir = path.join(temp, "pids-dir");
      fs.mkdirSync(dir);
      return dir;
    }],
  ])("cleans up the server and exits 2 when the PID file cannot be written in %s mode (%s)", (mode, _reason, brokenPidFile) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-pid-failure-test-"));
    const serverPidFile = path.join(temp, "server-pids.txt");
    try {
      const { result, ms } = runBenchmark(["--scenario", "single-cold", "--iterations", "1", "--concurrency", "1", "--timeout-ms", "500"], {
        DUO_MCP_BENCHMARK_FAKE_MODE: mode,
        DUO_MCP_BENCHMARK_PID_FILE: brokenPidFile(temp),
        DUO_MCP_BENCHMARK_SERVER_PID_FILE: serverPidFile,
        DUO_MCP_BENCHMARK_SERVER_SCRIPT: FAKE,
      });
      const why = describeRun(result, ms);
      // A harness failure: no report, and never disguised as the stage timeout the fake server would otherwise cause.
      expect(result.error, why).toBeUndefined();
      expect(result.signal, why).toBeNull();
      expect(result.status, why).toBe(2);
      expect(result.stdout, why).toBe("");
      expect(result.stderr, why).toContain("mcp-benchmark: internal error");
      expect(result.stderr, why).toContain("could not record server PID");
      const pids = fs.readFileSync(serverPidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.length, why).toBeGreaterThan(0);
      expect(pids.filter(processIsRunning), why).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, OUTER_LIMIT_MS + 5_000);
});
