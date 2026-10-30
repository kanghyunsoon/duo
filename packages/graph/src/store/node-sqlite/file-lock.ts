/**
 * Cross-process file lock on an otherwise unused SQLite database (T180). The lock is the operating
 * system's file lock behind an EXCLUSIVE transaction, so it is released when the holding process exits
 * for any reason (crash, Ctrl+C, kill). Nothing is written: no schema, no journal content.
 */
import { DatabaseSync } from "node:sqlite";

export interface HeldFileLock {
  /** Ends the transaction and closes the connection. Safe to call twice. */
  release(): void;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * Tries once, without waiting. Returns undefined when another connection, in this process or another,
 * holds the lock. Other errors (for example a directory at the path) are thrown.
 */
export function tryAcquireFileLock(path: string): HeldFileLock | undefined {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // No journal file next to the lock: the lock writes nothing, and a -journal path is one more entry
    // a symlink could redirect outside the worktree (#148 review). Busy here also means "held".
    db.exec("PRAGMA journal_mode = MEMORY");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
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

