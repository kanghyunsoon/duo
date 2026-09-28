/**
 * Module resolution per language (T18.0) behind the one ModuleResolver the builder uses. The builder
 * never learns language rules: each request carries SourceAnalysis.language and is answered by that
 * language's resolver, or "unsupported" (imports stay syntactic: no IMPORTS edge, no diagnostic).
 *
 *   typescript, tsx, javascript  TypeScriptModuleResolver (unchanged)
 *   python                       relative imports and same-repository absolute modules (root or src/)
 *   cpp                          quoted includes next to the including file
 *   java, csharp, others         unsupported
 */
import nodePath from "node:path";
import type { RepoPath } from "@duo-director/core";
import type { ModuleResolution, ModuleResolutionRequest, ModuleResolver } from "./module-resolver.js";
import { createTypeScriptModuleResolver, TYPESCRIPT_MODULE_RESOLUTION_VERSION } from "./typescript/typescript-module-resolver.js";

export const PYTHON_RESOLUTION_VERSION = "1";
export const CPP_INCLUDE_RESOLUTION_VERSION = "1";
/** Every resolver's version: a change recomputes stored module results (not the parse). */
export const MODULE_RESOLUTION_VERSION = `typescript=${TYPESCRIPT_MODULE_RESOLUTION_VERSION};python=${PYTHON_RESOLUTION_VERSION};cpp=${CPP_INCLUDE_RESOLUTION_VERSION}`;

const TS_LANGUAGES = new Set(["typescript", "tsx", "javascript"]);
/** Absolute Python modules are looked up under these repository directories. */
const PYTHON_ROOTS = ["", "src/"];

const posix = nodePath.posix;

function candidates(base: string, dotted: string): string[] {
  const rel = dotted.split(".").filter((s) => s !== "").join("/");
  const prefix = base === "" || base === "." ? "" : `${base}/`;
  if (rel === "") return [`${prefix}__init__.py`];
  return [`${prefix}${rel}.py`, `${prefix}${rel}/__init__.py`];
}

export function resolvePython(request: ModuleResolutionRequest, files: ReadonlySet<string>): ModuleResolution {
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
    found = [...new Set(PYTHON_ROOTS.flatMap((r) => candidates(r.replace(/\/$/u, ""), dotted)).filter((c) => files.has(c)))];
    // Not a repository module: the standard library or an installed package (not resolved, not an error).
    if (found.length === 0) return { status: "external", reason: "package" };
  }
  if (found.length > 1) return { status: "ambiguous", candidates: found.sort() as RepoPath[] };
  return { status: "resolved", path: found[0] as RepoPath, claim: "python-local", declarationOnly: false, extensionSubstituted: false };
}

export function resolveCppInclude(request: ModuleResolutionRequest, files: ReadonlySet<string>, system: boolean): ModuleResolution {
  if (system) return { status: "external", reason: "system-include" };
  const target = posix.normalize(posix.join(posix.dirname(request.fromPath), request.specifier));
  if (target.startsWith("../") || target === "..") return { status: "external", reason: "outside-repository" };
  // Include paths (-I, CMake targets, Unreal module paths) are not evaluated: not found here is not an error.
  return files.has(target) ? { status: "resolved", path: target as RepoPath, claim: "cpp-quoted-include", declarationOnly: false, extensionSubstituted: false }
    : { status: "external", reason: "include-path" };
}

export interface LanguageResolverOptions {
  readonly root: string;
  readonly indexedFiles: ReadonlySet<RepoPath>;
}

const TS_EXTENSION = /\.(?:[cm]?tsx?|[cm]?jsx?)$/iu;

export function createLanguageModuleResolver(options: LanguageResolverOptions): ModuleResolver {
  const ts = createTypeScriptModuleResolver({ root: options.root, indexedFiles: options.indexedFiles });
  const files = options.indexedFiles as ReadonlySet<string>;
  const isTs = (r: { readonly language?: string }) => r.language === undefined || TS_LANGUAGES.has(r.language);
  return {
    version: MODULE_RESOLUTION_VERSION,
    get diagnostics() { return ts.diagnostics; },
    // Only TypeScript/JavaScript files depend on tsconfig/jsconfig.
    configFiles: (fromPath) => (TS_EXTENSION.test(fromPath) ? ts.configFiles(fromPath) : []),
    configDiagnostics: (configPath, opts) => ts.configDiagnostics(configPath, opts),
    resolve(request) {
      if (isTs(request)) return ts.resolve(request);
      if (request.language === "python") return resolvePython(request, files);
      if (request.language === "cpp") return resolveCppInclude(request, files, request.syntax?.system === true);
      return { status: "unsupported", reason: `no module resolver for ${request.language ?? "this language"}` };
    },
  };
}
