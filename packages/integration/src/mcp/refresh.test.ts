/**
 * #172: follow-ups to the MCP automatic index refresh (#4, #133).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultAnalyzerRegistry } from "@duo-director/analyzer";
import { INDEX_STATE_FILE_PATH, indexRepository, openProjectGraphStore } from "@duo-director/graph";
import { describe, expect, it } from "vitest";
import { readWithSafeRefresh, TOOLS } from "./tools.js";

const op = (status: string) => ({ kind: "ok" as const, payload: { status }, diagnostics: [] });
const refreshedOnce = (calls: { n: number }) => async () => {
  calls.n += 1;
  return { value: { refreshed: true }, diagnostics: [] } as never;
};

describe("MCP automatic index refresh follow-ups (#172)", () => {
  it("gives a reason when the read after a successful refresh is still index-required", async () => {
    const calls = { n: 0 };
    let reads = 0;
    const result = await readWithSafeRefresh("/repo", async () => { reads += 1; return op("index-required"); }, undefined, refreshedOnce(calls));
    expect(calls.n).toBe(1);
    expect(reads).toBe(2);
    expect(result.kind === "ok" ? result.payload.indexRefresh : undefined).toEqual({ refreshed: true, reason: expect.stringContaining("stale again") });
    const summary = TOOLS.duo_get_context.summarize(result.kind === "ok" ? result.payload : {});
    expect(summary).toContain("INDEX_REQUIRED");
    expect(summary).toContain("DUO refreshed the index once, but the index became stale again");
  });

  it("adds no reason when the second read is ready", async () => {
    let reads = 0;
    const result = await readWithSafeRefresh("/repo", async () => op(reads++ === 0 ? "index-required" : "ready"), undefined, refreshedOnce({ n: 0 }));
    expect(result.kind === "ok" ? result.payload.indexRefresh : undefined).toEqual({ refreshed: true });
  });

  it("says still stale after the refresh check when the index was already current and then changed", async () => {
    // Another request refreshed first, so this one finds the index current ({ refreshed: false }); then a file changes.
    let reads = 0;
    const alreadyCurrent = async () => ({ value: { refreshed: false }, diagnostics: [] }) as never;
    const result = await readWithSafeRefresh("/repo", async () => { reads += 1; return op("index-required"); }, undefined, alreadyCurrent);
    expect(reads).toBe(2);
    expect(result.kind === "ok" ? result.payload.indexRefresh : undefined).toEqual({ refreshed: false, reason: expect.stringContaining("still stale after the automatic refresh check") });
    const summary = TOOLS.duo_review_changes.summarize(result.kind === "ok" ? result.payload : {});
    expect(summary).toContain("DUO checked the index once, but the index is still stale after the automatic refresh check");
    expect(summary).not.toContain("Automatic index refresh was not done");
    expect(summary).not.toContain("after the refresh (");
  });

  it("does not refresh for a request that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = { n: 0 };
    let reads = 0;
    const result = await readWithSafeRefresh("/repo", async () => { reads += 1; return op("index-required"); }, controller.signal, refreshedOnce(calls));
    expect(calls.n).toBe(0);
    expect(reads).toBe(1);
    expect(result).toEqual(op("index-required"));
  });
});

describe("MCP refresh after a DUO upgrade (#151 Stage B, index-state v5)", () => {
  it("keeps index-required with the exact reason for a v4 state, writes nothing, and never claims it was resolved", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-v4-")));
    const created = await createDefaultAnalyzerRegistry();
    if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
    try {
      fs.mkdirSync(path.join(root, ".duo-project"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, ".duo-project/project.yaml"), "schema_version: 1\nname: upgrade\n");
      fs.writeFileSync(path.join(root, ".gitignore"), ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n");
      fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
      git("-c", "init.defaultBranch=main", "init", "-q");
      git("-c", "user.email=t@duo.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "add", "-A");
      git("-c", "user.email=t@duo.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
      const store = openProjectGraphStore(root).value;
      if (store === undefined) throw new Error("graph");
      try { expect((await indexRepository(root, { store, registry: created.value })).value).toBeDefined(); } finally { store.close(); }
      // What an older DUO left behind: the same state at version 4, without absentConfigs.
      const statePath = path.join(root, INDEX_STATE_FILE_PATH);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      delete state.absentConfigs;
      fs.writeFileSync(statePath, `${JSON.stringify({ ...state, version: 4 })}\n`);
      const before = fs.readFileSync(statePath, "utf8");

      let reads = 0;
      const result = await readWithSafeRefresh(root, async () => { reads += 1; return op("index-required"); });
      expect(reads).toBe(1);
      const indexRefresh = result.kind === "ok" ? result.payload.indexRefresh : undefined;
      expect(indexRefresh?.refreshed).toBe(false);
      expect(indexRefresh?.reason).toContain("requires an existing compatible index (incompatible); run duoctl index explicitly");
      expect(fs.readFileSync(statePath, "utf8")).toBe(before);
      const summary = TOOLS.duo_get_context.summarize(result.kind === "ok" ? result.payload : {});
      expect(summary).toContain("INDEX_REQUIRED");
      expect(summary).toContain("Automatic index refresh was not done: Safe index refresh requires an existing compatible index (incompatible)");
    } finally {
      created.value.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
