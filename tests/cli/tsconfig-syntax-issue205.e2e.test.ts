/**
 * #205: a nearest tsconfig.json with a JSON syntax error made init and index fail on Windows with TypeScript's
 * "Debug Failure" (reported as CLI_USAGE_INVALID, exit 1). It is now a TSCONFIG_INVALID warning and indexing
 * completes, as for a tsconfig with only semantic errors. Before the fix this failed on Windows only, so the
 * 3-OS CI is the check. index does not print resolver warnings; they are kept in the index state.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

describe("#205: a tsconfig.json with a JSON syntax error", () => {
  const p = existingProject(temps);
  p.write("tsconfig.json", "{ not json");
  p.git("commit", "-qam", "break tsconfig");
  /** The TSCONFIG_INVALID warnings the last index kept in its state. */
  const invalid = () => {
    const state = JSON.parse(fs.readFileSync(path.join(p.root, ".duo-project", "generated", "index-state.json"), "utf8")) as { diagnostics: { code: string; message: string; source?: { path?: string } }[] };
    return state.diagnostics.filter((d) => d.code === "TSCONFIG_INVALID");
  };
  const expectReported = () => {
    const found = invalid();
    expect(found.map((d) => d.message)).toContain("tsconfig.json: ',' expected.");
    expect(found.every((d) => d.source?.path === "tsconfig.json")).toBe(true);
    expect(new Set(found.map((d) => d.message)).size).toBe(found.length);
  };

  it("init completes with the index and keeps TSCONFIG_INVALID instead of throwing", () => {
    const answers = [{ question: "project_goal", value: "Keep recurring chores fair." }];
    const init = duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify(answers));
    expect(init.stdout + init.stderr).not.toContain("Debug Failure");
    expect(init.code).toBe(0);
    expectReported();
  });

  it("index --full exits 0 and keeps TSCONFIG_INVALID for tsconfig.json", () => {
    const index = duoctl(p.root, ["index", "--full", "--json"]);
    expect(index.stdout + index.stderr).not.toContain("Debug Failure");
    expect(index.code).toBe(0);
    expectReported();
  });
});
