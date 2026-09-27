/**
 * .duo-project inspection (TASK-014). Classifies the state directory without writing, lists the Truth
 * and history files already there, finds entries in the way (symlinks, a file where a directory
 * belongs) and computes the basis digest apply uses to detect a change after planning. DUO's
 * regenerable areas (generated/, cache/, runtime/) are not part of the basis: indexing may change them.
 * Symlinks are never followed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  compareUtf8, createDiagnostic, loadProjectTruth, PROJECT_FILE_NAME, sha256Text, stableJson, STATE_DIR_NAME, WRITE_AREAS,
  type Diagnostic, type RepoPath,
} from "@duo-director/core";
import type { InitConflict, InitState } from "./types.js";

export interface StateEntry {
  readonly path: RepoPath;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly hash?: string;
}

export interface StateInspection {
  readonly state: InitState;
  /** Files inside .duo-project (outside the regenerable areas), UTF-8 order. */
  readonly existing: readonly RepoPath[];
  readonly entries: ReadonlyMap<RepoPath, StateEntry>;
  readonly conflicts: readonly InitConflict[];
  readonly blockers: readonly Diagnostic[];
  readonly basis: string;
}

const REGENERABLE = new Set(WRITE_AREAS.regenerable.map((a) => a.replace(/\/$/u, "")));
const PROJECT_FILE = `${STATE_DIR_NAME}/${PROJECT_FILE_NAME}` as RepoPath;

function typeOf(stat: fs.Stats): StateEntry["type"] {
  return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
}

function walk(root: string, dir: RepoPath, out: StateEntry[]): void {
  for (const name of fs.readdirSync(path.join(root, dir)).sort(compareUtf8)) {
    const rel = `${dir}/${name}` as RepoPath;
    if (dir === STATE_DIR_NAME && REGENERABLE.has(name)) continue;
    const type = typeOf(fs.lstatSync(path.join(root, rel)));
    if (type === "file") {
      out.push({ path: rel, type, hash: `sha256:${createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex")}` });
    } else {
      out.push({ path: rel, type });
      if (type === "directory") walk(root, rel, out);
    }
  }
}

/** Reads the state of .duo-project under a repository root. */
export function inspectStateDirectory(root: string): StateInspection {
  const entries: StateEntry[] = [];
  let top: StateEntry["type"] | undefined;
  try {
    top = typeOf(fs.lstatSync(path.join(root, STATE_DIR_NAME)));
  } catch {
    top = undefined;
  }
  if (top !== undefined) entries.push({ path: STATE_DIR_NAME as RepoPath, type: top });
  if (top === "directory") walk(root, STATE_DIR_NAME as RepoPath, entries);
  const byPath = new Map(entries.map((e) => [e.path, e] as const));
  const basis = sha256Text(stableJson(entries));
  const conflicts: InitConflict[] = entries.flatMap((e): InitConflict[] => {
    if (e.type === "symlink") return [{ path: e.path, reason: "symlink" }];
    if (e.path === STATE_DIR_NAME && e.type !== "directory") return [{ path: e.path, reason: "not-a-directory" }];
    if (e.path === PROJECT_FILE && e.type !== "file") return [{ path: e.path, reason: "not-a-file" }];
    return [];
  });
  const existing = entries.filter((e) => e.type === "file").map((e) => e.path);
  const blockers: Diagnostic[] = [];
  let state: InitState;
  const project = byPath.get(PROJECT_FILE);
  if (project?.type === "file" && conflicts.length === 0) {
    const loaded = loadProjectTruth(root);
    if (loaded.value !== undefined) {
      state = "initialized";
      blockers.push(createDiagnostic("INIT_ALREADY_INITIALIZED", `${STATE_DIR_NAME} is already initialized; init changes nothing (index with the Indexer instead)`, { path: PROJECT_FILE }));
    } else {
      state = "incompatible";
      const codes = [...new Set(loaded.diagnostics.filter((d) => d.severity === "error").map((d) => d.code))].sort(compareUtf8);
      blockers.push(createDiagnostic("INIT_INCOMPATIBLE", `${PROJECT_FILE} exists but cannot be read by this build (${codes.join(", ")}); init changes nothing`, { path: PROJECT_FILE }));
    }
  } else {
    state = existing.length > 0 || conflicts.length > 0 ? "partial" : "not-initialized";
  }
  for (const c of conflicts) blockers.push(createDiagnostic("INIT_CONFLICT", `"${c.path}" is a ${c.reason === "symlink" ? "symlink" : c.reason === "not-a-directory" ? "file where a directory belongs" : "directory where a file belongs"}; init does not write through or over it`, { path: c.path }));
  return { state, existing, entries: byPath, conflicts, blockers, basis };
}

