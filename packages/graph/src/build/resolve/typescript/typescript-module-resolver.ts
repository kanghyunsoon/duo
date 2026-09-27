/**
 * TypeScriptModuleResolver (TASK-007): standard TypeScript module resolution through the Compiler
 * API. DUO does not re-implement NodeNext, paths, baseUrl, index files, package exports/imports or
 * ".js" → ".ts" substitution. This file is the only place that imports "typescript"
 * (scripts/boundaries.json typescriptApi); no TypeScript type leaves it.
 */
import { builtinModules } from "node:module";
import nodePath from "node:path";
import { createDiagnostic, normalizeRepoPath, type Diagnostic, type RepoPath } from "@duo-director/core";
import ts from "typescript";
import type { ModuleResolution, ModuleResolutionRequest, ModuleResolver } from "../module-resolver.js";

export interface TypeScriptModuleResolverOptions {
  /** Absolute repository root. Resolution never looks for configuration above it. */
  readonly root: string;
  /** Indexed repository files (File Nodes). Anything else inside the repository is "not-indexed". */
  readonly indexedFiles: ReadonlySet<RepoPath>;
}

interface Config {
  readonly key: string;
  readonly path?: RepoPath;
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
}

const BUILTINS = new Set(builtinModules);
const URL_SPECIFIER = /^[a-z][a-z0-9+.-]*:/iu;
const DECLARATION = /\.d\.[cm]?ts$/u;
const EXPLICIT_JS_EXTENSION = /\.[cm]?jsx?$/u;

/** Options for files without a tsconfig.json/jsconfig.json: relative local modules only. */
const NO_CONFIG_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, noEmit: true,
};

export const TYPESCRIPT_VERSION: string = ts.version;

const isRelative = (s: string) => s === "." || s === ".." || s.startsWith("./") || s.startsWith("../");
const posix = (p: string) => p.replace(/\\/g, "/");

export function createTypeScriptModuleResolver(options: TypeScriptModuleResolverOptions): ModuleResolver {
  const root = nodePath.resolve(options.root);
  const diagnostics: Diagnostic[] = [];
  const configs = new Map<string, Config>();
  const nearest = new Map<string, Config | undefined>();
  const results = new Map<string, ModuleResolution>();
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => ts.sys.fileExists(f),
    readFile: (f) => ts.sys.readFile(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    realpath: (p) => (ts.sys.realpath === undefined ? p : ts.sys.realpath(p)),
    getCurrentDirectory: () => root,
    getDirectories: (d) => ts.sys.getDirectories(d),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };

  const toRepoPath = (absolute: string): RepoPath | undefined => {
    const relative = posix(nodePath.relative(root, absolute));
    if (relative === "" || relative === ".." || relative.startsWith("../") || nodePath.isAbsolute(relative)) return undefined;
    const p = normalizeRepoPath(relative).value;
    return p === relative ? p : undefined;
  };

  const loadConfig = (file: string, isJs: boolean): Config => {
    const cached = configs.get(file);
    if (cached !== undefined) return cached;
    const read = ts.readConfigFile(file, (f) => ts.sys.readFile(f));
    const repoPath = toRepoPath(file);
    const report = (d: ts.Diagnostic) => {
      if (d.category !== ts.DiagnosticCategory.Error) return;
      diagnostics.push(createDiagnostic("TSCONFIG_INVALID", `${repoPath ?? file}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`, repoPath === undefined ? undefined : { path: repoPath }));
    };
    if (read.error !== undefined) report(read.error);
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {}, ts.sys, nodePath.dirname(file), isJs ? { allowJs: true } : undefined, file,
    );
    // "No inputs were found" (18003) only concerns compilation, not resolution.
    parsed.errors.filter((d) => d.code !== 18003).forEach(report);
    const config: Config = {
      key: file, ...(repoPath === undefined ? {} : { path: repoPath }), options: parsed.options,
      cache: ts.createModuleResolutionCache(root, (f) => f, parsed.options),
    };
    configs.set(file, config);
    return config;
  };

  /** Nearest tsconfig.json (then jsconfig.json) from the file's directory up to the repository root. */
  const configFor = (dir: string): Config | undefined => {
    if (nearest.has(dir)) return nearest.get(dir);
    let found: Config | undefined;
    const ts1 = nodePath.join(dir, "tsconfig.json");
    const js1 = nodePath.join(dir, "jsconfig.json");
    if (ts.sys.fileExists(ts1)) found = loadConfig(ts1, false);
    else if (ts.sys.fileExists(js1)) found = loadConfig(js1, true);
    else if (nodePath.resolve(dir) !== root) {
      const parent = nodePath.dirname(dir);
      found = parent === dir ? undefined : configFor(parent);
    }
    nearest.set(dir, found);
    return found;
  };
  const noConfig: Config = { key: "", options: NO_CONFIG_OPTIONS, cache: ts.createModuleResolutionCache(root, (f) => f, NO_CONFIG_OPTIONS) };

  const resolveUncached = (request: ModuleResolutionRequest): ModuleResolution => {
    const { specifier } = request;
    if (specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0] ?? "")) return { status: "external", reason: "builtin" };
    if (URL_SPECIFIER.test(specifier)) return { status: "unsupported", reason: "URL specifier" };
    if (specifier.startsWith("/") || nodePath.isAbsolute(specifier)) return { status: "unsupported", reason: "absolute specifier" };
    const containing = posix(nodePath.join(root, request.fromPath));
    const config = configFor(nodePath.dirname(nodePath.join(root, request.fromPath)));
    // Without a config DUO knows no project semantics: only relative local modules are resolved.
    if (config === undefined && !isRelative(specifier)) return { status: "external", reason: "package" };
    const active = config ?? noConfig;
    const implied = ts.getImpliedNodeFormatForFile(containing, active.cache.getPackageJsonInfoCache(), host, active.options);
    const mode = request.kind === "require" ? ts.ModuleKind.CommonJS
      : request.kind === "dynamic-import" ? ts.ModuleKind.ESNext
        : implied;
    const resolved = ts.resolveModuleName(specifier, containing, active.options, host, active.cache, undefined, mode).resolvedModule;
    if (resolved === undefined) return isRelative(specifier) ? { status: "unresolved", reason: "not-found" } : { status: "external", reason: "package" };
    const file = posix(resolved.resolvedFileName);
    if (resolved.isExternalLibraryImport === true || file.split("/").includes("node_modules")) return { status: "external", reason: "package" };
    const repoPath = toRepoPath(file);
    if (repoPath === undefined) return { status: "external", reason: "outside-repository" };
    if (!options.indexedFiles.has(repoPath)) return { status: "unresolved", reason: "not-indexed" };
    const specifierExtension = EXPLICIT_JS_EXTENSION.exec(specifier)?.[0];
    return {
      status: "resolved", path: repoPath, claim: "typescript-resolution",
      declarationOnly: DECLARATION.test(repoPath),
      extensionSubstituted: specifierExtension !== undefined && !repoPath.endsWith(specifierExtension),
      ...(config?.path === undefined ? {} : { configPath: config.path }),
    };
  };

  return {
    diagnostics,
    resolve(request) {
      const key = `${request.fromPath}\u0000${request.kind}\u0000${request.specifier}`;
      let result = results.get(key);
      if (result === undefined) {
        result = resolveUncached(request);
        results.set(key, result);
      }
      return result;
    },
  };
}
