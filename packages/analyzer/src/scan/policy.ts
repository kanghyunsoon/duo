/**
 * Which repository entries the scanner indexes (TASK-004, docs/10-security.md). Pure functions over
 * RepoPaths; case-sensitive except for the secret patterns, which err on the side of exclusion.
 */
import { compileRepoPattern, STATE_DIR_NAME, WRITE_AREAS, type RepoPath } from "@duo-director/core";
import type { ExclusionReason } from "./types.js";

/** File name patterns that are never indexed, even when tracked (docs/10-security.md). Matched case-insensitively. */
export const SECRET_FILE_PATTERNS: readonly string[] = [".env*", "*.pem", "*.key", "id_rsa*", "*.p12", "secrets.*", "credentials*"];

/** DUO's own regenerable areas (ADR-006), e.g. ".duo-project/generated/". */
const DUO_REGENERABLE_PREFIXES = WRITE_AREAS.regenerable.map((area) => `${STATE_DIR_NAME}/${area}`);
/** Review Records (ADR-006 human-history). Recording a Review must not make the index stale or change the next diff. */
const DUO_HISTORY_PREFIXES = WRITE_AREAS["human-history"].map((area) => `${STATE_DIR_NAME}/${area}`);

type Matcher = (path: RepoPath) => boolean;

function compileAll(patterns: readonly string[]): Matcher[] {
  return patterns.flatMap((p) => {
    const m = compileRepoPattern(p);
    return m === undefined ? [] : [m];
  });
}

const secretMatchers = compileAll(SECRET_FILE_PATTERNS);

export function isSecretFileName(path: RepoPath): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase() as RepoPath;
  return secretMatchers.some((m) => m(name));
}

export interface PathPolicy {
  /** The reason a path is excluded, or undefined when it is indexed. */
  exclusionOf(path: RepoPath): ExclusionReason | undefined;
  /** Patterns from include/exclude that are not valid repository globs. */
  readonly invalidPatterns: readonly string[];
}

/** Precedence: git-internal, duo-regenerable, duo-history, secret, index-exclude, not-included. */
export function createPathPolicy(include: readonly string[] = [], exclude: readonly string[] = []): PathPolicy {
  const includeMatchers = compileAll(include);
  const excludeMatchers = compileAll(exclude);
  const invalidPatterns = [...include, ...exclude].filter((p) => compileRepoPattern(p) === undefined);
  return {
    invalidPatterns,
    exclusionOf(path) {
      if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) return "git-internal";
      if (DUO_REGENERABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) return "duo-regenerable";
      if (DUO_HISTORY_PREFIXES.some((prefix) => path.startsWith(prefix))) return "duo-history";
      if (isSecretFileName(path)) return "secret";
      if (excludeMatchers.some((m) => m(path))) return "index-exclude";
      if (include.length > 0 && !includeMatchers.some((m) => m(path))) return "not-included";
      return undefined;
    },
  };
}
