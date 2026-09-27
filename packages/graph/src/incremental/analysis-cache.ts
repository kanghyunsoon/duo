/**
 * SourceAnalysis cache (TASK-008): .duo-project/cache/analysis/<key>.json, regenerable (ADR-006).
 * Entries are content-addressed by (path, contentHash, analyzer, analyzerVersion) and immutable, so
 * they need no coordination with the graph: a missing, foreign or corrupt entry is a cache miss and
 * the file is parsed again. Entries hold syntax facts only, never source text.
 */
import { createHash } from "node:crypto";
import type { SourceAnalysis } from "@duo-director/analyzer";
import { STATE_DIR_NAME, type Diagnostic, type RepoPath } from "@duo-director/core";
import { pruneRegenerableDirectory, readRegenerable, writeRegenerable } from "./files.js";

export const ANALYSIS_CACHE_DIR = `${STATE_DIR_NAME}/cache/analysis`;
const FORMAT = "duo-analysis-cache";
const VERSION = 1;

export interface AnalysisCacheKey {
  readonly path: RepoPath;
  readonly contentHash: string;
  readonly analyzer: string;
  readonly analyzerVersion: string;
}

export interface CachedAnalysis {
  readonly analysis: SourceAnalysis;
  readonly diagnostics: readonly Diagnostic[];
}

export function analysisCacheFileName(key: AnalysisCacheKey): string {
  const digest = createHash("sha256").update([key.path, key.contentHash, key.analyzer, key.analyzerVersion].join("\u0000")).digest("hex");
  return `${digest}.json`;
}

export function readCachedAnalysis(root: string, key: AnalysisCacheKey): CachedAnalysis | undefined {
  const read = readRegenerable(root, `${ANALYSIS_CACHE_DIR}/${analysisCacheFileName(key)}`);
  if (read.text === undefined) return undefined;
  try {
    const entry = JSON.parse(read.text) as Record<string, unknown>;
    const analysis = entry.analysis as SourceAnalysis | undefined;
    const matches = entry.format === FORMAT && entry.version === VERSION && entry.path === key.path && entry.contentHash === key.contentHash
      && entry.analyzer === key.analyzer && entry.analyzerVersion === key.analyzerVersion
      && analysis?.path === key.path && analysis.contentHash === key.contentHash && Array.isArray(entry.diagnostics);
    return matches ? { analysis, diagnostics: entry.diagnostics as Diagnostic[] } : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedAnalysis(root: string, key: AnalysisCacheKey, value: CachedAnalysis): readonly Diagnostic[] {
  const text = JSON.stringify({ format: FORMAT, version: VERSION, ...key, analysis: value.analysis, diagnostics: value.diagnostics });
  return writeRegenerable(root, `${ANALYSIS_CACHE_DIR}/${analysisCacheFileName(key)}`, text).diagnostics;
}

/** Deletes entries no current file uses. */
export function pruneAnalysisCache(root: string, keep: readonly AnalysisCacheKey[]): number {
  return pruneRegenerableDirectory(root, ANALYSIS_CACHE_DIR, new Set(keep.map(analysisCacheFileName)));
}
