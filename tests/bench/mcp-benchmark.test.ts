import { execFileSync } from "node:child_process";
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
});
