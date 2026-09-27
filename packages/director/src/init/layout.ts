/**
 * The .duo-project layout init creates (TASK-014, ADR-006, docs/03). Paths come from the core
 * namespace constants only. Empty directories are created locally but not kept in Git (no .gitkeep):
 * every DUO writer creates its directory on demand, so a fresh clone without them works the same.
 */
import { STATE_DIR_NAME, type RepoPath, type WriteKind } from "@duo-director/core";

const S = STATE_DIR_NAME;

export const INIT_FILES = {
  project: `${S}/project.yaml` as RepoPath,
  gitignore: `${S}/.gitignore` as RepoPath,
  vision: `${S}/intent/vision.md` as RepoPath,
  constraints: `${S}/intent/constraints.yaml` as RepoPath,
} as const;

export const milestoneFile = (id: string) => `${S}/milestones/${id}.yaml` as RepoPath;

/** Directories in creation order (parents first) with the write kind their contents have. */
export const INIT_DIRECTORIES: readonly { readonly path: RepoPath; readonly kind: WriteKind }[] = [
  { path: S as RepoPath, kind: "project-truth" },
  { path: `${S}/intent` as RepoPath, kind: "project-truth" },
  { path: `${S}/specs` as RepoPath, kind: "project-truth" },
  { path: `${S}/decisions` as RepoPath, kind: "project-truth" },
  { path: `${S}/decisions/proposals` as RepoPath, kind: "project-truth" },
  { path: `${S}/milestones` as RepoPath, kind: "project-truth" },
  { path: `${S}/integrations` as RepoPath, kind: "project-truth" },
  { path: `${S}/reviews` as RepoPath, kind: "human-history" },
  { path: `${S}/generated` as RepoPath, kind: "regenerable" },
  { path: `${S}/cache` as RepoPath, kind: "regenerable" },
  { path: `${S}/runtime` as RepoPath, kind: "regenerable" },
];

/** ADR-006: the ignored areas, one per line. */
export const GITIGNORE_TEXT = "generated/\ncache/\nruntime/\n";

