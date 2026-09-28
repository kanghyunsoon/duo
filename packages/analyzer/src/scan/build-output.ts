/**
 * Build outputs and tool caches (T18.0). The scanner lists what Git tracks plus untracked files that
 * are not ignored, so these matter only in a repository that does not ignore them. A directory is a
 * build output only with evidence: its name alone for tool caches that are never source, otherwise
 * the build manifest next to it. Without that evidence the directory is indexed like any other.
 *
 *   always                         .gradle/ __pycache__/ .pytest_cache/ .mypy_cache/ .ruff_cache/ .tox/ site-packages/
 *   pyvenv.cfg inside              any virtual environment directory (.venv/, venv/, ...)
 *   pom.xml / build.gradle(.kts)   target/ next to it; build/ next to a Gradle build or settings file
 *   CMakeCache.txt inside          a CMake build directory
 *   *.csproj next to it            bin/ obj/
 *   Unity project root             Library/ Temp/ Logs/ obj/ (ProjectSettings/ProjectVersion.txt next to them)
 *   *.uproject / *.uplugin         Binaries/ Intermediate/ Saved/ DerivedDataCache/ next to it
 */
import type { RepoPath } from "@duo-director/core";

/** Bump when the rules change (they decide which files are indexed). */
export const BUILD_OUTPUT_RULES_VERSION = "1";

const ALWAYS = new Set([".gradle", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "site-packages"]);
const UNITY = new Set(["Library", "Temp", "Logs", "obj"]);
const UNREAL = new Set(["Binaries", "Intermediate", "Saved", "DerivedDataCache"]);

/** Returns a predicate: is the path inside a build output directory of this file set? */
export function buildOutputMatcher(paths: readonly RepoPath[]): (path: RepoPath) => boolean {
  const names = new Map<string, Set<string>>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash < 0 ? "" : p.slice(0, slash);
    let set = names.get(dir);
    if (set === undefined) names.set(dir, (set = new Set()));
    set.add(p.slice(slash + 1));
  }
  const has = (dir: string, name: string) => names.get(dir)?.has(name) === true;
  const some = (dir: string, re: RegExp) => [...(names.get(dir) ?? [])].some((n) => re.test(n));
  const cache = new Map<string, boolean>();
  const isOutput = (dir: string): boolean => {
    let v = cache.get(dir);
    if (v !== undefined) return v;
    const slash = dir.lastIndexOf("/");
    const parent = slash < 0 ? "" : dir.slice(0, slash);
    const name = dir.slice(slash + 1);
    v = ALWAYS.has(name) || has(dir, "pyvenv.cfg") || has(dir, "CMakeCache.txt")
      || (name === "target" && (has(parent, "pom.xml") || some(parent, /^build\.gradle(?:\.kts)?$/u)))
      || (name === "build" && some(parent, /^(?:build|settings)\.gradle(?:\.kts)?$/u))
      || ((name === "bin" || name === "obj") && some(parent, /\.csproj$/u))
      || (UNITY.has(name) && has(parent === "" ? "ProjectSettings" : `${parent}/ProjectSettings`, "ProjectVersion.txt"))
      || (UNREAL.has(name) && some(parent, /\.(?:uproject|uplugin)$/u));
    cache.set(dir, v);
    return v;
  };
  return (path) => {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) if (isOutput(segments.slice(0, i).join("/"))) return true;
    return false;
  };
}

