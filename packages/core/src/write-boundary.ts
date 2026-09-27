/**
 * Write boundary policy (AC-002-04, REQ-SAFETY-001). Decides where DUO may write; it does not
 * write. The future file writer must call checkWriteBoundary() first and must also resolve
 * symlinks (realpath) before writing, which this pure policy cannot see.
 */
import { STATE_DIR_NAME } from "./constants.js";
import { createDiagnostic, failure, success, type ParseResult } from "./diagnostics.js";
import { normalizeRepoPath, normalizeRepoPattern, type RepoPath } from "./paths.js";

/** What is being written. Each kind maps to fixed areas of the state directory (ADR-006). */
export type WriteKind = "project-truth" | "human-history" | "regenerable";

/** Areas relative to the state directory. A trailing "/" means "anything below this directory". */
export const WRITE_AREAS: Readonly<Record<WriteKind, readonly string[]>> = {
  "project-truth": ["project.yaml", "intent/", "specs/", "decisions/", "milestones/", "integrations/"],
  "human-history": ["reviews/"],
  regenerable: ["generated/", "cache/", "runtime/"],
};

export interface AllowedWrite {
  readonly path: RepoPath;
  readonly kind: WriteKind;
  /** Matched area, repository-relative, e.g. ".duo-project/decisions/". */
  readonly area: string;
}

export interface WriteBoundaryOptions {
  /**
   * Further restriction for a specific caller, as repository-relative paths or directory
   * prefixes ending in "/" (e.g. ".duo-project/decisions/proposals/" for an agent).
   * It can only narrow the default areas, never widen them.
   */
  readonly restrictTo?: readonly string[];
}

function matches(inner: string, area: string): boolean {
  return area.endsWith("/") ? inner.startsWith(area) && inner.length > area.length : inner === area;
}

/**
 * Checks whether DUO may write targetPath as writeKind. targetPath may be repository-relative or
 * absolute (host path under repositoryRoot). Paths outside the repository are always rejected;
 * inside it, only the areas of WRITE_AREAS for the given kind are allowed. Project source code
 * is never a write target.
 */
export function checkWriteBoundary(
  repositoryRoot: string,
  targetPath: string,
  writeKind: WriteKind,
  options: WriteBoundaryOptions = {},
): ParseResult<AllowedWrite> {
  const normalized = normalizeRepoPath(targetPath, { root: repositoryRoot });
  if (normalized.value === undefined) {
    const outside = normalized.diagnostics.some((d) => d.code === "PATH_OUTSIDE_REPOSITORY");
    return failure(outside
      ? [createDiagnostic("WRITE_OUTSIDE_REPOSITORY", `Refusing to write "${targetPath}": it is outside the repository`)]
      : normalized.diagnostics);
  }
  const path = normalized.value;
  const prefix = `${STATE_DIR_NAME}/`;
  if (!path.startsWith(prefix)) {
    return failure([createDiagnostic(
      "WRITE_NOT_ALLOWED",
      `Refusing to write "${path}": DUO writes only under ${prefix} and never writes project source code`,
      { path },
    )]);
  }
  const inner = path.slice(prefix.length);
  const kinds = Object.keys(WRITE_AREAS) as WriteKind[];
  const found = kinds.flatMap((kind) => WRITE_AREAS[kind].filter((a) => matches(inner, a)).map((area) => ({ kind, area })))[0];
  if (found === undefined) {
    return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${path}": not a ${prefix} write area`, { path })]);
  }
  if (found.kind !== writeKind) {
    return failure([createDiagnostic(
      "WRITE_NOT_ALLOWED",
      `Refusing to write "${path}" as ${writeKind}: ${prefix}${found.area} holds ${found.kind} data`,
      { path },
    )]);
  }
  if (options.restrictTo !== undefined) {
    const allowed = options.restrictTo.some((r) => {
      const p = normalizeRepoPattern(r).value;
      return p !== undefined && (p.endsWith("/") ? path.startsWith(p) && path.length > p.length : path === p);
    });
    if (!allowed) {
      return failure([createDiagnostic("WRITE_NOT_ALLOWED", `Refusing to write "${path}": outside the paths allowed for this caller`, { path })]);
    }
  }
  return success({ path, kind: writeKind, area: prefix + found.area });
}

