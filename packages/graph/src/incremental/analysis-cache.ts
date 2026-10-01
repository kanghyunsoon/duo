/**
 * SourceAnalysis cache (TASK-008): .duo-project/cache/analysis/<key>.json, regenerable (ADR-006).
 * Entries are content-addressed by (path, contentHash, analyzer, analyzer identity) and immutable, so
 * they need no coordination with the graph: a missing, foreign or corrupt entry is a cache miss and
 * the file is parsed again. Entries hold syntax facts only, never source text.
 *
 * One check decides validity for both the Indexer and inspectIndex (parseCachedAnalysis). Entries are
 * read with bounded concurrency (T25.1): every entry still gets the symlink check of each path segment,
 * the read and the key check, and results come back in the order of the keys, so the completion order
 * of the reads never shows. Any failure (missing, unreadable, symlink, corrupt, foreign) is a miss.
 */
import { createHash } from "node:crypto";
import type { SourceAnalysis } from "@duo-director/analyzer";
import { STATE_DIR_NAME, type Diagnostic, type RepoPath } from "@duo-director/core";
import { pruneRegenerableDirectory, readRegenerableAsync, writeRegenerable } from "./files.js";

export const ANALYSIS_CACHE_DIR = `${STATE_DIR_NAME}/cache/analysis`;
const FORMAT = "duo-analysis-cache";
/** 2 (T18.0): keyed by the analyzer identity (grammar digests included). */
const VERSION = 2;
/** Entries read at the same time (T25.1). */
export const ANALYSIS_CACHE_READ_CONCURRENCY = 16;

export interface AnalysisCacheKey {
  readonly path: RepoPath;
  readonly contentHash: string;
  readonly analyzer: string;
  readonly analyzerIdentity: string;
}

export interface CachedAnalysis {
  readonly analysis: SourceAnalysis;
  readonly diagnostics: readonly Diagnostic[];
}

export function analysisCacheFileName(key: AnalysisCacheKey): string {
  const digest = createHash("sha256").update([key.path, key.contentHash, key.analyzer, key.analyzerIdentity].join("\u0000")).digest("hex");
  return `${digest}.json`;
}

/** The entry for key in text, or undefined when text is not a valid entry for exactly that key. */
export function parseCachedAnalysis(text: string, key: AnalysisCacheKey): CachedAnalysis | undefined {
  try {
    const entry = JSON.parse(text) as Record<string, unknown>;
    const analysis = entry.analysis as SourceAnalysis | undefined;
    const matches = entry.format === FORMAT && entry.version === VERSION && entry.path === key.path && entry.contentHash === key.contentHash
      && entry.analyzer === key.analyzer && entry.analyzerIdentity === key.analyzerIdentity
      && analysis?.path === key.path && analysis.contentHash === key.contentHash && Array.isArray(entry.diagnostics);
    return matches ? { analysis, diagnostics: entry.diagnostics as Diagnostic[] } : undefined;
  } catch {
    return undefined;
  }
}

async function readOne(root: string, key: AnalysisCacheKey): Promise<CachedAnalysis | undefined> {
  const read = await readRegenerableAsync(root, `${ANALYSIS_CACHE_DIR}/${analysisCacheFileName(key)}`);
  return read.text === undefined ? undefined : parseCachedAnalysis(read.text, key);
}

/** fn over items with at most limit running at once; results in item order. fn must not reject. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** The cached analysis for each key (undefined: a miss), in key order (Indexer). */
export function readCachedAnalyses(root: string, keys: readonly AnalysisCacheKey[], concurrency = ANALYSIS_CACHE_READ_CONCURRENCY): Promise<(CachedAnalysis | undefined)[]> {
  return mapBounded(keys, concurrency, (key) => readOne(root, key));
}

/** Whether each key has a valid entry, in key order (inspectIndex: the same check, the analysis is not kept). */
export function cachedAnalysesValid(root: string, keys: readonly AnalysisCacheKey[], concurrency = ANALYSIS_CACHE_READ_CONCURRENCY): Promise<boolean[]> {
  return mapBounded(keys, concurrency, async (key) => (await readOne(root, key)) !== undefined);
}

export function writeCachedAnalysis(root: string, key: AnalysisCacheKey, value: CachedAnalysis): readonly Diagnostic[] {
  const text = JSON.stringify({ format: FORMAT, version: VERSION, ...key, analysis: value.analysis, diagnostics: value.diagnostics });
  return writeRegenerable(root, `${ANALYSIS_CACHE_DIR}/${analysisCacheFileName(key)}`, text).diagnostics;
}

/** Deletes entries no current file uses. */
export function pruneAnalysisCache(root: string, keep: readonly AnalysisCacheKey[]): number {
  return pruneRegenerableDirectory(root, ANALYSIS_CACHE_DIR, new Set(keep.map(analysisCacheFileName)));
}
