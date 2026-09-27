/**
 * File-level change primitive (TASK-004). Compares the previous and current fingerprints by
 * contentHash only; mtime plays no part. The Indexer (TASK-008) turns these results into Graph
 * node freshness; this module does not touch the Graph.
 */
import { compareUtf8, type RepoPath } from "@duo-director/core";
import type { FileFingerprint } from "./fingerprint.js";

export type FingerprintChangeStatus = "UNCHANGED" | "CHANGED" | "ADDED" | "DELETED";

export interface FingerprintChange {
  readonly path: RepoPath;
  readonly status: FingerprintChangeStatus;
  readonly previous?: FileFingerprint;
  readonly current?: FileFingerprint;
}

/**
 * One entry per path in either set, in UTF-8 path order. CHANGED means a different contentHash or
 * kind. A state change (untracked → tracked) with the same content is UNCHANGED; both
 * fingerprints are attached so the caller can see it. A rename is DELETED + ADDED.
 */
export function compareFingerprints(previous: readonly FileFingerprint[], current: readonly FileFingerprint[]): FingerprintChange[] {
  const before = new Map(previous.map((f) => [f.path, f]));
  const after = new Map(current.map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8);
  const changes: FingerprintChange[] = [];
  for (const p of paths) {
    const a = before.get(p);
    const b = after.get(p);
    if (a === undefined && b !== undefined) changes.push({ path: p, status: "ADDED", current: b });
    else if (b === undefined && a !== undefined) changes.push({ path: p, status: "DELETED", previous: a });
    else if (a !== undefined && b !== undefined) {
      const same = a.contentHash === b.contentHash && a.kind === b.kind;
      changes.push({ path: p, status: same ? "UNCHANGED" : "CHANGED", previous: a, current: b });
    }
  }
  return changes;
}
