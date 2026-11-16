/**
 * #172: follow-ups to the MCP automatic index refresh (#4, #133).
 */
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

  it("passes the request signal into the refresh and skips the second read once it is cancelled", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    let reads = 0;
    const cancelDuringRefresh = async (_root: string, options?: { signal?: AbortSignal }) => {
      seen = options?.signal;
      controller.abort();
      return { value: { refreshed: true }, diagnostics: [] } as never;
    };
    const result = await readWithSafeRefresh("/repo", async () => { reads += 1; return op("index-required"); }, controller.signal, cancelDuringRefresh);
    expect(seen).toBe(controller.signal);
    expect(reads).toBe(1);
    expect(result).toEqual(op("index-required"));
  });
});
