import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { checkWriteBoundary, createDiagnostic, failure, STATE_DIR_NAME, success, type ParseResult } from "@duo-director/core";
import { tryAcquireFileLock, type HeldFileLock } from "../store/node-sqlite/file-lock.js";

/**
 * T180: an operating-system file lock (released when the holder exits, also on a crash or kill).
 * The lock directory used by #143 at .duo-project/generated/index-write.lock is no longer used.
 */
export const INDEX_WRITE_LOCK_PATH = `${STATE_DIR_NAME}/generated/index-writer.lock`;
export interface IndexWriteLockOptions { readonly lockTimeoutMs?: number }
export interface IndexWriteLease { readonly root: string }
const leases = new WeakMap<IndexWriteLease, { active: boolean; indexing: boolean; pending: Set<Promise<unknown>> }>();

/** A symlink, whether or not its target exists (existsSync follows links and misses dangling ones). */
function isSymlink(entry: string): boolean {
  try {
    return fs.lstatSync(entry).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

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
 * The lock belongs to the holding process: if it exits without releasing (crash, Ctrl+C, kill), the
 * operating system releases it, so no stale lock is left and nothing is ever taken over by age.
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
  // Reject symlinked write directories, lock file or journal path (also dangling ones) before SQLite
  // could follow them and create a file outside this worktree (#148 review).
  try {
    for (const relative of [STATE_DIR_NAME, `${STATE_DIR_NAME}/generated`, INDEX_WRITE_LOCK_PATH, `${INDEX_WRITE_LOCK_PATH}-journal`]) {
      if (isSymlink(path.join(rootDir, relative))) {
        return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock refused: symlink ${relative}`)]);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock unavailable: ${(error as Error).message}`)]);
  }
  let held: HeldFileLock | undefined;
  for (;;) {
    try {
      held = tryAcquireFileLock(file);
    } catch (error) {
      return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock unavailable: ${(error as Error).message}`)]);
    }
    if (held !== undefined) break;
    if (performance.now() >= deadline) {
      return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Index lock timeout: another DUO index writer in this worktree holds ${INDEX_WRITE_LOCK_PATH}; no index write was started. Run again when it finishes`)]);
    }
    await setTimeout(20);
  }
  const lease = Object.freeze({ root: rootDir });
  const state = { active: true, indexing: false, pending: new Set<Promise<unknown>>() };
  leases.set(lease, state);
  try { return success(await fn(lease)); } finally {
    try {
      await finishIndexWriteLease(lease);
    } finally {
      held.release();
    }
  }
}
