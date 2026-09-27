/**
 * File access of the DecisionService (T09). Every write goes through guardDecisionWrite(): the core
 * write boundary for the target kind and actor, a fixed file name made from an allocated ID, and no
 * symlink on the path. Replacements are atomic (temp file + rename); new Decision files are created
 * exclusively (temp file + hard link), so two writers never get the same ID.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { STATE_DIR_NAME } from "../constants.js";
import { createDiagnostic, failure, success, type ParseResult } from "../diagnostics.js";
import { createFileExclusive, symlinkOnPath, writeFileAtomic } from "../fs-guard.js";
import { PROPOSAL_ID_PATTERN } from "../ids.js";
import type { RepoPath } from "../paths.js";
import type { ACTOR_KINDS } from "../schema/schemas.js";
import { checkWriteBoundary } from "../write-boundary.js";

export const DECISIONS_DIR = `${STATE_DIR_NAME}/decisions`;
export const PROPOSALS_DIR = `${DECISIONS_DIR}/proposals`;
export const DECISION_LOCK_PATH = `${STATE_DIR_NAME}/runtime/locks/decisions.lock`;

const DECISION_FILE = /^D-\d+\.yaml$/;

export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface DecisionActor {
  readonly kind: ActorKind;
  /** Display name recorded in the files (e.g. Git user.name, an agent name). */
  readonly name: string;
}

export function decisionPath(id: string): RepoPath {
  return `${DECISIONS_DIR}/${id}.yaml` as RepoPath;
}

export function proposalPath(id: string): RepoPath {
  return `${PROPOSALS_DIR}/${id}.yaml` as RepoPath;
}

export type DecisionWriteTarget = "proposal" | "decision" | "lock";

/**
 * May this actor write this path as this target? proposal: decisions/proposals/P-*.yaml, any actor.
 * decision: decisions/D-###.yaml, human only. lock: the runtime decision lock.
 */
export function guardDecisionWrite(root: string, actor: DecisionActor, repoPath: string, target: DecisionWriteTarget): ParseResult<{ readonly path: RepoPath; readonly absolute: string }> {
  const name = repoPath.slice(repoPath.lastIndexOf("/") + 1);
  let checked;
  if (target === "proposal") {
    if (!PROPOSAL_ID_PATTERN.test(name.replace(/\.yaml$/u, "")) || !name.endsWith(".yaml")) {
      return failure([createDiagnostic("WRITE_NOT_ALLOWED", `"${repoPath}" is not a proposal file name`)]);
    }
    checked = checkWriteBoundary(root, repoPath, "project-truth", { restrictTo: [`${PROPOSALS_DIR}/`] });
  } else if (target === "decision") {
    if (actor.kind !== "human") {
      return failure([createDiagnostic("DECISION_ACTOR_FORBIDDEN", `${actor.kind} "${actor.name}" cannot write Decision files; only a human confirms`)]);
    }
    if (!DECISION_FILE.test(name)) return failure([createDiagnostic("WRITE_NOT_ALLOWED", `"${repoPath}" is not a Decision file name`)]);
    checked = checkWriteBoundary(root, repoPath, "project-truth", { restrictTo: [`${DECISIONS_DIR}/${name}`] });
  } else {
    checked = checkWriteBoundary(root, repoPath, "regenerable", { restrictTo: [DECISION_LOCK_PATH] });
  }
  if (checked.value === undefined) return failure(checked.diagnostics);
  const link = symlinkOnPath(root, checked.value.path);
  if (link !== undefined) return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${checked.value.path}": "${link}" is a symlink`, { path: checked.value.path })]);
  return success({ path: checked.value.path, absolute: path.join(root, checked.value.path) });
}

/** The file operations the service needs (injectable for failure tests). */
export interface DecisionFileSystem {
  readText(absolute: string): Promise<string | undefined>;
  list(absoluteDir: string): Promise<string[]>;
  /** Replaces the file atomically (temp file + rename). */
  writeAtomic(absolute: string, text: string): Promise<void>;
  /** Creates the file with this content only if it does not exist; false when it exists. */
  createExclusive(absolute: string, text: string): Promise<boolean>;
  remove(absolute: string): Promise<void>;
}

export const nodeDecisionFileSystem: DecisionFileSystem = {
  async readText(absolute) {
    try {
      return await fsp.readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async list(absoluteDir) {
    try {
      return await fsp.readdir(absoluteDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  writeAtomic: writeFileAtomic,
  createExclusive: createFileExclusive,
  async remove(absolute) {
    await fsp.rm(absolute, { force: true });
  },
};

