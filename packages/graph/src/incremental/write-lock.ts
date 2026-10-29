import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { checkWriteBoundary, createDiagnostic, failure, STATE_DIR_NAME, success, type ParseResult } from "@duo-director/core";

export const INDEX_WRITE_LOCK_PATH = `${STATE_DIR_NAME}/generated/index-write.lock`;
export interface IndexWriteLockOptions { readonly lockTimeoutMs?: number }
export interface IndexWriteLease { readonly root: string }
const leases = new WeakMap<IndexWriteLease, { active: boolean; indexing: boolean; pending: Set<Promise<unknown>> }>();

export async function finishIndexWriteLease(lease: IndexWriteLease): Promise<void> {
  const state = leases.get(lease);
  if (state === undefined) return;
  state.active = false;
  await Promise.allSettled(state.pending);
}

/** Internal capability use: one index operation at a time, only while its outer owner awaits it. */
export async function useIndexWriteLease<T>(root: string, lease: IndexWriteLease, fn: () => Promise<T>): Promise<ParseResult<T>> {
  const state = leases.get(lease);
  if (state?.active !== true || lease.root !== fs.realpathSync(root) || state.indexing) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", "Invalid or concurrently used index write lease")]);
  }
  state.indexing = true;
  const operation = Promise.resolve().then(fn);
  state.pending.add(operation);
  try { return success(await operation); } finally { state.pending.delete(operation); state.indexing = false; }
}

/** Serialize every index writer, including DB open/recreation and sidecar/cache writes.
 * No time-based lock stealing: an interrupted writer requires explicit operator cleanup.
 */
export async function withIndexWriteLock<T>(root: string, fn: (lease: IndexWriteLease) => Promise<T>, options: IndexWriteLockOptions = {}): Promise<ParseResult<T>> {
  let rootDir: string;
  try { rootDir = fs.realpathSync(root); } catch (error) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock unavailable: ${(error as Error).message}`)]);
  }
  const allowed = checkWriteBoundary(rootDir, INDEX_WRITE_LOCK_PATH, "regenerable");
  if (allowed.value === undefined) return failure(allowed.diagnostics);
  const file = path.join(rootDir, allowed.value.path);
  const timeout = options.lockTimeoutMs ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 0) return failure([createDiagnostic("GRAPH_WRITE_REFUSED", "Index lock timeout must be a finite non-negative number")]);
  const deadline = performance.now() + timeout;
  // Reject symlinked write directories before creating anything outside this worktree.
  try {
    for (const relative of [STATE_DIR_NAME, `${STATE_DIR_NAME}/generated`]) {
      const dir = path.join(rootDir, relative);
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
        return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock refused: symlink directory ${relative}`)]);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock unavailable: ${(error as Error).message}`)]);
  }
  for (;;) {
    try { fs.mkdirSync(file); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock unavailable: ${(error as Error).message}`)]);
      }
      if (performance.now() >= deadline) return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock timeout: ${INDEX_WRITE_LOCK_PATH} is held; no index write was started`)]);
      await setTimeout(20);
    }
  }
  const lease = Object.freeze({ root: rootDir });
  const state = { active: true, indexing: false, pending: new Set<Promise<unknown>>() };
  leases.set(lease, state);
  try { return success(await fn(lease)); } finally {
    await finishIndexWriteLease(lease);
    fs.rmdirSync(file);
  }
}
