/**
 * Module resolution per language (T18.0) behind the one ModuleResolver the builder uses. The builder
 * never learns language rules: each request carries SourceAnalysis.language and is answered by that
 * language's resolver, or "unsupported" (imports stay syntactic: no IMPORTS edge, no diagnostic).
 *
 *   typescript, tsx, javascript  TypeScriptModuleResolver (unchanged)
 *   python                       relative imports and same-repository absolute modules under the discovered source roots (./python.ts, C219)
 *   cpp                          quoted includes next to the including file
 *   java, csharp, others         unsupported
 */
import nodePath from "node:path";
import { readSourceFile, type RepoPath } from "@duo-director/core";
import type { ModuleResolution, ModuleResolutionRequest, ModuleResolver } from "./module-resolver.js";
import { discoverPythonRoots, isPythonMetadataFile, resolvePython, type PythonRoots } from "./python.js";
import { createTypeScriptModuleResolver, TYPESCRIPT_MODULE_RESOLUTION_VERSION } from "./typescript/typescript-module-resolver.js";

export { discoverPythonRoots, resolvePython, type PythonRoot, type PythonRootBasis, type PythonRoots } from "./python.js";

/** 2: C219 source roots (package parents, project metadata) besides the repository root and src/. */
export const PYTHON_RESOLUTION_VERSION = "2";
export const CPP_INCLUDE_RESOLUTION_VERSION = "1";
/** Every resolver's version: a change recomputes stored module results (not the parse). */
export const MODULE_RESOLUTION_VERSION = `typescript=${TYPESCRIPT_MODULE_RESOLUTION_VERSION};python=${PYTHON_RESOLUTION_VERSION};cpp=${CPP_INCLUDE_RESOLUTION_VERSION}`;

const TS_LANGUAGES = new Set(["typescript", "tsx", "javascript"]);

const posix = nodePath.posix;

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
const PY_EXTENSION = /\.py$/u;

export function createLanguageModuleResolver(options: LanguageResolverOptions): ModuleResolver {
  const ts = createTypeScriptModuleResolver({ root: options.root, indexedFiles: options.indexedFiles });
  const files = options.indexedFiles as ReadonlySet<string>;
  const isTs = (r: { readonly language?: string }) => r.language === undefined || TS_LANGUAGES.has(r.language);
  // Python source roots: discovered once, on the first Python request, from the indexed files and in-repository metadata.
  let python: PythonRoots | undefined;
  const pythonRoots = () => (python ??= discoverPythonRoots(files, (p) => readSourceFile(options.root, p).value));
  return {
    version: MODULE_RESOLUTION_VERSION,
    get diagnostics() { return ts.diagnostics; },
    // TypeScript/JavaScript files depend on tsconfig/jsconfig; Python files on the project metadata that decided the roots
    // (a changed pyproject.toml or setup.cfg re-resolves them; added or removed files already do).
    configFiles: (fromPath) => (TS_EXTENSION.test(fromPath) ? ts.configFiles(fromPath) : PY_EXTENSION.test(fromPath) ? pythonRoots().metadata : []),
    configDiagnostics: (configPath, opts) => (isPythonMetadataFile(configPath) ? [] : ts.configDiagnostics(configPath, opts)),
    resolve(request) {
      if (isTs(request)) return ts.resolve(request);
      if (request.language === "python") return resolvePython(request, files, pythonRoots());
      if (request.language === "cpp") return resolveCppInclude(request, files, request.syntax?.system === true);
      return { status: "unsupported", reason: `no module resolver for ${request.language ?? "this language"}` };
    },
  };
}
