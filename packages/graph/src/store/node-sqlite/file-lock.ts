/**
 * Cross-process file lock on an otherwise unused SQLite database (T180). The lock is the operating
 * system's file lock behind an EXCLUSIVE transaction, so it is released when the holding process exits
 * for any reason (crash, Ctrl+C, kill). Nothing is written: no schema, no journal content.
 *
 * Because nothing is ever written, a lock file is always an empty regular file with one link. Anything
 * else at the path (a symlink, a hard link, a non-empty file) may alias a file outside the worktree,
 * for example an external WAL database whose header `PRAGMA journal_mode` would rewrite (#148 review),
 * so it is refused before SQLite opens it, and checked again through the open connection before the
 * first statement that could write.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface HeldFileLock {
  /** Ends the transaction and closes the connection. Safe to call twice. */
  release(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** The path holds something that is not an index lock; it was not opened or was closed unchanged. */
export class FileLockRefusedError extends Error {}

/** undefined when absent; otherwise the entry, if it is an empty regular file with exactly one link. */
function inspectLockEntry(path: string): fs.Stats | undefined {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new FileLockRefusedError("it is a symlink");
  if (!entry.isFile()) throw new FileLockRefusedError("it is not a regular file");
  if (entry.nlink > 1) throw new FileLockRefusedError(`it is a hard link (${entry.nlink} links)`);
  if (entry.size > 0) throw new FileLockRefusedError("it is not empty");
  return entry;
}

/**
 * Tries once, without waiting. Returns undefined when another connection, in this process or another,
 * holds the lock. Throws FileLockRefusedError when the path holds anything but an empty, singly linked
 * regular file; other errors are thrown as they are.
 */
export function tryAcquireFileLock(path: string): HeldFileLock | undefined {
  const before = inspectLockEntry(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Opening reads at most and writes nothing. Before anything that could write: the path still names
    // the same empty, singly linked file (no swap between the check and the open), and the file this
    // connection actually opened is empty. The second check reads through the open connection, so it
    // holds even if the path changes again afterwards.
    const after = inspectLockEntry(path);
    if (after === undefined || (before !== undefined && (after.dev !== before.dev || after.ino !== before.ino))) {
      throw new FileLockRefusedError("it was replaced while being opened");
    }
    if (Number(db.prepare("PRAGMA page_count").get()?.page_count ?? -1) !== 0) throw new FileLockRefusedError("the opened file is not empty");
    // No journal file next to the lock: the lock writes nothing, and a -journal path is one more entry
    // a symlink could redirect outside the worktree (#148 review). Busy here also means "held".
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (error instanceof FileLockRefusedError) throw error;
    const code = (error as { errcode?: unknown }).errcode;
    if (typeof code === "number" && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)) return undefined;
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}

