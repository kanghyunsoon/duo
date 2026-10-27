import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      const result = spawnSync(process.execPath, [path.resolve("bench/mcp.mjs"), "--iterations", "1", "--concurrency", "1", "--timeout-ms", "500"], {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          DUO_MCP_BENCHMARK_FAKE_MODE: mode,
          DUO_MCP_BENCHMARK_PID_FILE: pidFile,
          DUO_MCP_BENCHMARK_SERVER_SCRIPT: path.resolve("tests/bench/fixtures/unresponsive-mcp.mjs"),
        },
        timeout: 15_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { scenarios: Record<string, { errors: Array<{ stage: string; kind: string }> }> };
      expect(Object.values(report.scenarios).flatMap((scenario) => scenario.errors)).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage, kind: "timeout" })]),
      );
      const pids = fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.filter(processIsRunning)).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
