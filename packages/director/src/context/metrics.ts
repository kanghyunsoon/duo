/**
 * Request-level token metrics (09 지표, TASK-010). Repository tokens are the o200k_base sum over
 * the indexed files' canonical text (the index's fingerprint list; raw-mode files are counted as
 * binary and have no token value). Per-file counts can be memoized by content hash in
 * .duo-project/cache/token-counts.json (ADR-005: the calculation and its cache location are
 * decided in TASK-010). These values are outside the Packet on purpose: a change in an unrelated
 * file changes the repository total without touching any Packet.
 */
import fs from "node:fs";
import path from "node:path";
import { readFingerprintFile } from "@duo-director/analyzer";
import { checkWriteBoundary, readSourceFile, STATE_DIR_NAME } from "@duo-director/core";
import { codePoints, TOKEN_ESTIMATOR_ID } from "../tokens/index.js";
import type { TokenMeter } from "./meter.js";

export const TOKEN_COUNT_CACHE_PATH = `${STATE_DIR_NAME}/cache/token-counts.json`;
const FORMAT = "duo.token-counts/1";

export interface RepositoryTokens {
  readonly files: number;
  readonly binaryFiles: number;
  readonly tokens: number;
  readonly bytes: number;
  readonly chars: number;
  /** Tokens per indexed text file. */
  readonly perFile: ReadonlyMap<string, number>;
}

/**
 * Caller-owned, in-memory token counts by content hash (TASK-019). A count is a pure function of the
 * canonical text, which the content hash identifies, so a hit gives the same value a fresh count
 * would; the metrics do not change. Nothing is written. After each call the memo holds exactly the
 * current files' entries, so a long-lived process (MCP, UI) stays bounded by the repository.
 */
export type TokenCountMemo = Map<string, { readonly tokens: number; readonly chars: number }>;

function readCounts(root: string): Map<string, { tokens: number; chars: number }> {
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(root, TOKEN_COUNT_CACHE_PATH), "utf8")) as { format?: unknown; estimator?: unknown; counts?: Record<string, [number, number]> };
    if (entry.format !== FORMAT || entry.estimator !== TOKEN_ESTIMATOR_ID || entry.counts === undefined) return new Map();
    return new Map(Object.entries(entry.counts).map(([k, [tokens, chars]]) => [k, { tokens, chars }] as const));
  } catch {
    return new Map();
  }
}

function writeCounts(root: string, counts: ReadonlyMap<string, { tokens: number; chars: number }>): void {
  const allowed = checkWriteBoundary(root, TOKEN_COUNT_CACHE_PATH, "regenerable");
  if (allowed.value === undefined) return;
  const target = path.join(root, allowed.value.path);
  const temp = `${target}.${process.pid}.tmp`;
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [v.tokens, v.chars]]));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify({ format: FORMAT, estimator: TOKEN_ESTIMATOR_ID, counts: sorted }));
    fs.renameSync(temp, target);
  } catch {
    fs.rmSync(temp, { force: true });
  }
}

export function repositoryTokens(root: string, meter: TokenMeter, useCache: boolean, memo?: TokenCountMemo): RepositoryTokens {
  const fingerprints = readFingerprintFile(root).value ?? [];
  const cached = useCache ? readCounts(root) : new Map<string, { tokens: number; chars: number }>();
  const next = new Map<string, { tokens: number; chars: number }>();
  const perFile = new Map<string, number>();
  let tokens = 0, bytes = 0, chars = 0, binaryFiles = 0;
  for (const f of fingerprints) {
    bytes += f.size;
    if (f.fingerprintMode !== "normalized-text") { binaryFiles++; continue; }
    let v = memo?.get(f.contentHash) ?? cached.get(f.contentHash);
    if (v === undefined) {
      const text = readSourceFile(root, f.path).value;
      if (text === undefined) continue;
      v = { tokens: meter.count(text), chars: codePoints(text) };
    }
    next.set(f.contentHash, v);
    perFile.set(f.path, v.tokens);
    tokens += v.tokens;
    chars += v.chars;
  }
  if (useCache && (next.size !== cached.size || [...next.keys()].some((k) => !cached.has(k)))) writeCounts(root, next);
  if (memo !== undefined) {
    memo.clear();
    for (const [k, v] of next) memo.set(k, v);
  }
  return { files: fingerprints.length, binaryFiles, tokens, bytes, chars, perFile };
}

/** (1 − selected / base) × 100 with two decimals; null when base is 0. */
export function reduction(selected: number, base: number): number | null {
  return base <= 0 ? null : Math.round((1 - selected / base) * 10_000) / 100;
}
