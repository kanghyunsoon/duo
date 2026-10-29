import fs from "node:fs";
import path from "node:path";
import { createDiagnostic, failure, requireCompleteTruth, loadProjectTruth, success, type ParseResult } from "@duo-director/core";
import { GRAPH_DB_FILE_PATH, indexRepository, openProjectGraphReader, openProjectGraphStore, type IndexOptions } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { withIndexWriteLock, type IndexWriteLockOptions } from "./write-lock.js";
import { captureIndexInputs } from "./inputs.js";
import { INDEX_STATE_TOKEN_KEY, readIndexState } from "./state.js";

export interface RefreshIndexResult { readonly refreshed: boolean }
export type RefreshIndexOptions = Pick<IndexOptions, "registry" | "historyWindow" | "onPhase"> & IndexWriteLockOptions;

/** Opt-in recovery for MCP callers. Failure means keep index-required and display diagnostics.
 * Never bootstrap or recreate missing/incompatible indexes. CLI remains explicitly driven.
 */
export async function refreshIndexIfSafe(root: string, options: RefreshIndexOptions = {}): Promise<ParseResult<RefreshIndexResult>> {
  try {
    return await refreshUnderGuard(root, options);
  } catch (error) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Safe index refresh failed: ${error instanceof Error ? error.message : String(error)}`)]);
  }
}

async function refreshUnderGuard(root: string, options: RefreshIndexOptions): Promise<ParseResult<RefreshIndexResult>> {
  const locked = await withIndexWriteLock(root, async (lease): Promise<ParseResult<RefreshIndexResult>> => {
    const truth = requireCompleteTruth(loadProjectTruth(root));
    if (truth.value === undefined) return failure(truth.diagnostics);
    const scope = { include: truth.value.truth.config.index.include, exclude: truth.value.truth.config.index.exclude };
    const truthSignature = JSON.stringify(truth.value.truth);
    const extra = Object.keys(readIndexState(root).state?.configs ?? {});
    const before = await captureIndexInputs(root, extra, scope);
    if (before.value === undefined) return failure(before.diagnostics);
    const stable = async () => {
      const after = await captureIndexInputs(root, extra, scope);
      return after.value?.signature === before.value?.signature && JSON.stringify(loadProjectTruth(root).value?.truth) === truthSignature;
    };
    const moved = () => failure<RefreshIndexResult>([createDiagnostic("GRAPH_WRITE_REFUSED", "Safe index refresh refused: repository inputs changed during recovery")]);
    const dbFile = path.join(path.resolve(root), GRAPH_DB_FILE_PATH);
    const identity = fs.existsSync(dbFile) ? fs.statSync(dbFile) : undefined;
    const opened = openProjectGraphReader(root);
    if (opened.value === undefined) return failure(opened.diagnostics);
    const expectedToken = opened.value.readMeta(INDEX_STATE_TOKEN_KEY);
    const sameIndex = (token: string | undefined): boolean => {
      if (identity === undefined || token === undefined || readIndexState(root).state?.token !== token) return false;
      try {
        const now = fs.statSync(dbFile);
        if (now.dev !== identity.dev || now.ino !== identity.ino) return false;
        const reader = openProjectGraphReader(root);
        if (reader.value === undefined) return false;
        try { return reader.value.readMeta(INDEX_STATE_TOKEN_KEY) === token; } finally { reader.value.close(); }
      } catch { return false; }
    };
    let status;
    try { status = await inspectIndex(root, { graph: opened.value, ...options }); } finally { opened.value.close(); }
    if (status.value === undefined) return failure(status.diagnostics);
    if (status.value.status !== "current" && status.value.status !== "stale") return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Safe index refresh requires an existing compatible index (${status.value.status}); run duoctl index explicitly`), ...status.diagnostics]);
    // Use current scan membership: newly added visible Truth is safe to incrementally index.
    const recorded = new Set(status.value.freshness.filter((file) => file.file !== "deleted" && file.file !== "unknown").map((file) => file.path));
    const unobserved = truth.value.truth.files.filter((file) => !recorded.has(file));
    if (unobserved.length > 0) return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Safe index refresh cannot verify Truth inputs absent from the index scan: ${unobserved.join(", ")}. Check Git ignore/index include rules and run duoctl index explicitly`)]);
    if (status.value.status === "current") return await stable() && sameIndex(expectedToken) ? success({ refreshed: false }) : moved();
    if (expectedToken === undefined || !sameIndex(expectedToken)) return failure([createDiagnostic("GRAPH_WRITE_REFUSED", "Safe index refresh refused: existing index state changed or disappeared")]);
    const writer = openProjectGraphStore(root, { existingOnly: true });
    if (writer.value === undefined) return failure(writer.diagnostics);
    try {
      const indexed = await indexRepository(root, { ...options, store: writer.value, writeLease: lease, expectedToken });
      if (indexed.value === undefined) return failure(indexed.diagnostics);
      if (indexed.diagnostics.some((d) => d.severity === "error")) return failure(indexed.diagnostics);
      const checked = await inspectIndex(root, { ...options, graph: writer.value });
      if (checked.value?.status !== "current" || checked.diagnostics.some((d) => d.severity === "error")) {
        return failure([createDiagnostic("GRAPH_WRITE_REFUSED", "Safe index refresh could not verify a current index after writing"), ...checked.diagnostics]);
      }
      if (!await stable() || !sameIndex(readIndexState(root).state?.token)) return moved();
      return success({ refreshed: true }, indexed.diagnostics);
    } finally { writer.value.close(); }
  }, options);
  return locked.value ?? failure(locked.diagnostics);
}
