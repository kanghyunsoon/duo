/**
 * Python source roots (C219, T24.2): where an absolute import such as `from app.models import X` is
 * looked up. Discovered once per index from the indexed file set and in-repository project metadata;
 * no interpreter, no site-packages, no virtual environment, no PYTHONPATH, nothing outside the
 * repository. Directory names (backend, api, server, app) are never special.
 *
 * Roots and the files that may use them:
 *
 *   repository   the repository root, for every file (as before C219)
 *   src          `src/`, for every file (as before C219)
 *   package      the parent directory of a top-level regular package: a directory with __init__.py
 *                whose parent has none and whose name is a Python identifier. Used by files under
 *                that parent directory.
 *   metadata     a Python project directory P (pyproject.toml with [project], [build-system] or
 *                [tool.poetry]; setup.cfg with [metadata] or [options]) and P/src when it holds
 *                Python files: the default package places of setuptools, hatchling and poetry. Used
 *                by files under P. Not derived when P has setup.py (code, not read) or the metadata
 *                moves packages (package-dir, packages, where, sources, ...): those stay UNKNOWN and
 *                only the structural roots apply.
 *
 * A module found under more than one root a file may use is ambiguous: no IMPORTS edge is guessed.
 */
import nodePath from "node:path";
import { compareUtf8, type RepoPath } from "@duo-director/core";
import type { ModuleResolution, ModuleResolutionRequest } from "./module-resolver.js";

const posix = nodePath.posix;

export type PythonRootBasis = "repository" | "src" | "package" | "metadata";

export interface PythonRoot {
  /** Repository-relative directory ("" = repository root). */
  readonly path: string;
  /** Files under this directory may use the root ("" = every file). */
  readonly scope: string;
  readonly basis: PythonRootBasis;
}

export interface PythonRoots {
  /** Ordered by path, then scope (UTF-8): independent of file system order. */
  readonly roots: readonly PythonRoot[];
  /** pyproject.toml and setup.cfg files whose text decided metadata roots (their changes re-resolve Python imports). */
  readonly metadata: readonly RepoPath[];
}

const METADATA_FILE = /^(?:pyproject\.toml|setup\.cfg)$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** A table that makes the directory a packaging project (tool-only configuration does not). */
const PROJECT_TABLE = /^\s*\[(?:project|build-system|tool\.poetry|metadata|options)\]\s*(?:#.*)?$/mu;
/** Package placement that build backends read: not interpreted here (UNKNOWN). */
const PACKAGE_OVERRIDE = /^\s*(?:package[-_]dir|packages|py[-_]modules|where|sources|only-include|only-packages)\s*=|^\s*\[(?:tool\.setuptools\.packages(?:\.find)?|options\.packages\.find|tool\.hatch\.build(?:\.[^\]]*)?|tool\.pdm\.build)\]/mu;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);
const under = (file: string, dir: string) => dir === "" || file.startsWith(`${dir}/`);

export function discoverPythonRoots(files: ReadonlySet<string>, readText: (path: RepoPath) => string | undefined = () => undefined): PythonRoots {
  const roots = new Map<string, PythonRoot>();
  const add = (r: PythonRoot) => { const key = `${r.path}\u0000${r.scope}`; if (!roots.has(key)) roots.set(key, r); };
  add({ path: "", scope: "", basis: "repository" });
  add({ path: "src", scope: "", basis: "src" });
  const metadata: RepoPath[] = [];
  const projects: string[] = [];
  for (const f of files) {
    const name = baseOf(f);
    const dir = dirOf(f);
    if (name === "__init__.py" && dir !== "" && IDENTIFIER.test(baseOf(dir)) && !files.has(join(dirOf(dir), "__init__.py"))) {
      add({ path: dirOf(dir), scope: dirOf(dir), basis: "package" });
    }
    if (METADATA_FILE.test(name)) {
      metadata.push(f as RepoPath);
      projects.push(f);
    }
  }
  for (const f of projects.sort(compareUtf8)) {
    const p = dirOf(f);
    if (files.has(join(p, "setup.py"))) continue;
    const text = readText(f as RepoPath);
    if (text === undefined || !PROJECT_TABLE.test(text) || PACKAGE_OVERRIDE.test(text)) continue;
    // Both metadata files of one directory must agree that nothing is moved.
    const other = join(p, baseOf(f) === "setup.cfg" ? "pyproject.toml" : "setup.cfg");
    if (files.has(other)) { const t = readText(other as RepoPath); if (t === undefined || PACKAGE_OVERRIDE.test(t)) continue; }
    add({ path: p, scope: p, basis: "metadata" });
    const src = join(p, "src");
    for (const g of files) if (g.endsWith(".py") && g.startsWith(`${src}/`)) { add({ path: src, scope: p, basis: "metadata" }); break; }
  }
  return {
    roots: [...roots.values()].sort((a, b) => compareUtf8(a.path, b.path) || compareUtf8(a.scope, b.scope)),
    metadata: metadata.sort(compareUtf8),
  };
}

function candidates(base: string, dotted: string): string[] {
  const rel = dotted.split(".").filter((s) => s !== "").join("/");
  const prefix = base === "" || base === "." ? "" : `${base}/`;
  if (rel === "") return [`${prefix}__init__.py`];
  return [`${prefix}${rel}.py`, `${prefix}${rel}/__init__.py`];
}

export function resolvePython(request: ModuleResolutionRequest, files: ReadonlySet<string>, roots: PythonRoots = discoverPythonRoots(files)): ModuleResolution {
  const spec = request.specifier;
  const level = /^\.*/u.exec(spec)?.[0].length ?? 0;
  const dotted = spec.slice(level);
  let found: string[];
  if (level > 0) {
    let dir = posix.dirname(request.fromPath);
    for (let i = 1; i < level; i++) dir = posix.dirname(dir);
    if (dir === "..") return { status: "external", reason: "outside-repository" };
    found = candidates(dir, dotted).filter((c) => files.has(c));
    if (found.length === 0) return { status: "unresolved", reason: "not-found" };
  } else {
    const bases = [...new Set(roots.roots.filter((r) => under(request.fromPath, r.scope)).map((r) => r.path))];
    found = [...new Set(bases.flatMap((b) => candidates(b, dotted)).filter((c) => files.has(c)))];
    // Not a repository module: the standard library or an installed package (not resolved, not an error).
    if (found.length === 0) return { status: "external", reason: "package" };
  }
  if (found.length > 1) return { status: "ambiguous", candidates: found.sort(compareUtf8) as RepoPath[] };
  return { status: "resolved", path: found[0] as RepoPath, claim: "python-local", declarationOnly: false, extensionSubstituted: false };
}

/** A Python project metadata file (its configDiagnostics are empty: it is not a tsconfig). */
export const isPythonMetadataFile = (path: string) => METADATA_FILE.test(baseOf(path));

