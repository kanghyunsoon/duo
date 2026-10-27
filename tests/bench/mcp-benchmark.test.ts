import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP benchmark smoke", () => {
  it("runs all scenarios and reports every tool", () => {
    const stdout = execFileSync(process.execPath, [path.resolve("bench/mcp.mjs"), "--smoke"], {
      cwd: path.resolve("."), encoding: "utf8", windowsHide: true, timeout: 300_000,
    });
    const result = JSON.parse(stdout) as {
      format: string;
      toolContract: { names: string[]; verified: boolean };
      scenarios: Record<string, { errorCount: number; latency: Record<string, unknown> }>;
    };
    expect(result.format).toBe("duo.mcp-benchmark/1");
    expect(result.toolContract).toMatchObject({ verified: true, names: expect.arrayContaining(["duo_get_status", "duo_propose_decision"]) });
    expect(Object.keys(result.scenarios).sort()).toEqual(["concurrent-cold", "concurrent-warm", "single-cold", "single-warm"]);
    for (const scenario of Object.values(result.scenarios)) {
      expect(scenario.errorCount).toBe(0);
      expect(Object.keys(scenario.latency)).toEqual(expect.arrayContaining(["initialize", "tools/list", ...result.toolContract.names]));
    }
  }, 300_000);

  it("reports an initialization timeout and exits non-zero", () => {
    const result = spawnSync(process.execPath, [path.resolve("bench/mcp.mjs"), "--smoke", "--timeout-ms", "50"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: { ...process.env, DUO_MCP_BENCHMARK_SERVER_SCRIPT: path.resolve("tests/bench/fixtures/unresponsive-mcp.mjs") },
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { scenarios: Record<string, { errors: Array<{ stage: string; kind: string }> }> };
    expect(Object.values(report.scenarios).flatMap((scenario) => scenario.errors)).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "initialize", kind: "timeout" })]),
    );
  }, 30_000);
});
