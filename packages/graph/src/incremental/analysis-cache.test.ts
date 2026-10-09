/**
 * T25.1: the bounded-concurrency cache check returns exactly what the sequential check returned, entry by entry,
 * for every kind of failure, at every concurrency, in key order whatever the completion order of the reads.
 * The reference is the pre-T25.1 implementation (readRegenerable + the same entry check), kept here only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SourceAnalysis } from "@duo-director/analyzer";
import type { RepoPath } from "@duo-director/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_CACHE_DIR, analysisCacheFileName, cachedAnalysesValid, parseCachedAnalysis, readCachedAnalyses, writeCachedAnalysis,
  type AnalysisCacheKey, type CachedAnalysis,
} from "./analysis-cache.js";
import { readRegenerable } from "./files.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
afterEach(() => vi.restoreAllMocks());

/** The sequential check before T25.1. */
function reference(root: string, key: AnalysisCacheKey): CachedAnalysis | undefined {
  const read = readRegenerable(root, `${ANALYSIS_CACHE_DIR}/${analysisCacheFileName(key)}`);
  return read.text === undefined ? undefined : parseCachedAnalysis(read.text, key);
}

const keyOf = (i: number, identity = "sha256:id"): AnalysisCacheKey => ({ path: `src/f${i}.ts` as RepoPath, contentHash: `sha256:c${i}`, analyzer: "typescript", analyzerIdentity: identity });
const analysis = (k: AnalysisCacheKey) => ({ path: k.path, contentHash: k.contentHash, language: "typescript", symbols: [], diagnostics: [] }) as unknown as SourceAnalysis;
const entryPath = (root: string, k: AnalysisCacheKey) => path.join(root, ANALYSIS_CACHE_DIR, analysisCacheFileName(k));

/** A cache with valid entries and one of each failure the check knows. Returns the keys and the failures it could make. */
function cacheWithFailures(): { root: string; keys: AnalysisCacheKey[]; made: string[] } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-cache-check-")));
  temps.push(root);
  const keys = Array.from({ length: 40 }, (_, i) => keyOf(i));
  for (const k of keys) expect(writeCachedAnalysis(root, k, { analysis: analysis(k), diagnostics: [] })).toEqual([]);
  const made = ["valid"];
  fs.rmSync(entryPath(root, keys[1] as AnalysisCacheKey)); made.push("ENOENT");
  fs.writeFileSync(entryPath(root, keys[2] as AnalysisCacheKey), "{"); made.push("truncated JSON");
  fs.writeFileSync(entryPath(root, keys[3] as AnalysisCacheKey), "not json"); made.push("invalid JSON");
  fs.copyFileSync(entryPath(root, keys[5] as AnalysisCacheKey), entryPath(root, keys[4] as AnalysisCacheKey)); made.push("another key's entry");
  const foreign = keyOf(6, "sha256:other");
  fs.writeFileSync(entryPath(root, keys[6] as AnalysisCacheKey), JSON.stringify({ format: "duo-analysis-cache", version: 2, ...foreign, analysis: analysis(foreign), diagnostics: [] }));
  made.push("another analyzer identity");
  const wrongSource = { ...(keys[7] as AnalysisCacheKey), contentHash: "sha256:changed" };
  fs.writeFileSync(entryPath(root, keys[7] as AnalysisCacheKey), JSON.stringify({ format: "duo-analysis-cache", version: 2, ...(keys[7] as AnalysisCacheKey), analysis: analysis(wrongSource), diagnostics: [] }));
  made.push("another source identity");
  fs.rmSync(entryPath(root, keys[8] as AnalysisCacheKey)); fs.mkdirSync(entryPath(root, keys[8] as AnalysisCacheKey)); made.push("a directory where a file is expected");
  const target = entryPath(root, keys[9] as AnalysisCacheKey);
  fs.renameSync(target, target + ".real");
  try {
    fs.symlinkSync(target + ".real", target);
    made.push("symlink where a regular file is expected");
  } catch {
    fs.renameSync(target + ".real", target); // no symlink permission (Windows without developer mode)
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) { fs.chmodSync(entryPath(root, keys[10] as AnalysisCacheKey), 0o000); made.push("unreadable file"); }
  return { root, keys, made };
}

describe("analysis cache check (T25.1)", () => {
  it("returns the sequential result for every entry and every failure, at every concurrency", async () => {
    const { root, keys, made } = cacheWithFailures();
    const expected = keys.map((k) => reference(root, k));
    // Failures are misses, never exceptions; valid entries are found.
    expect(expected.filter((x) => x === undefined).length).toBe(made.length - 1);
    for (const c of [1, 4, 8, 16, 32, 64]) {
      expect(await readCachedAnalyses(root, keys, c), `concurrency ${c}`).toEqual(expected);
      expect(await cachedAnalysesValid(root, keys, c), `concurrency ${c}`).toEqual(expected.map((x) => x !== undefined));
    }
    // Results follow the keys, not the directory or a sorted order.
    const shuffled = [...keys].reverse();
    expect(await readCachedAnalyses(root, shuffled)).toEqual(shuffled.map((k) => reference(root, k)));
    expect(await readCachedAnalyses(root, [])).toEqual([]);
    // C253 (T48): about 0.3 s alone, about 5 s under the full suite on Windows. The default 5 s timeout let the
    // unfinished reads run on into the next tests, so this test gets its own limit.
  }, 30_000);

  it("a symlinked cache directory makes every entry a miss, as before", async () => {
    const { root, keys } = cacheWithFailures();
    const dir = path.join(root, ANALYSIS_CACHE_DIR);
    fs.renameSync(dir, dir + "-real");
    try {
      fs.symlinkSync(dir + "-real", dir, "junction");
    } catch {
      return; // the platform does not allow it here
    }
    const expected = keys.map((k) => reference(root, k));
    expect(expected.every((x) => x === undefined)).toBe(true);
    expect(await readCachedAnalyses(root, keys)).toEqual(expected);
  });

  it("never runs more reads than the limit, and the completion order does not change the result", async () => {
    const { root, keys } = cacheWithFailures();
    const expected = keys.map((k) => reference(root, k));
    const original = fs.promises.readFile.bind(fs.promises);
    let inFlight = 0, peak = 0, n = 0;
    vi.spyOn(fs.promises, "readFile").mockImplementation((async (...args: Parameters<typeof fs.promises.readFile>) => {
      // Only this test's reads count: a read from another test's cache passes through uncounted (C253).
      if (!String(args[0]).startsWith(root)) return original(...args);
      inFlight++; peak = Math.max(peak, inFlight);
      // Later keys finish first: reverse completion order.
      await new Promise((r) => setTimeout(r, 20 - (n++ % 20)));
      try { return await original(...args); } finally { inFlight--; }
    }) as typeof fs.promises.readFile);
    expect(await readCachedAnalyses(root, keys, 4)).toEqual(expected);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

