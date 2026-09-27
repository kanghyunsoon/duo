/**
 * Module resolution for the Graph Builder (TASK-007). The builder depends only on this interface;
 * the TypeScript Compiler API stays inside TypeScriptModuleResolver (./typescript/), so a future
 * TypeScript 7 API change replaces that one adapter.
 */
import type { ModuleReferenceKind } from "@duo-director/analyzer";
import type { Diagnostic, RepoPath } from "@duo-director/core";

export interface ModuleResolutionRequest {
  /** File that contains the reference. */
  readonly fromPath: RepoPath;
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
}

export type ModuleResolution =
  | {
      readonly status: "resolved";
      /** An indexed repository file (a File Node). */
      readonly path: RepoPath;
      /**
       * What the result claims: TypeScript's module resolution picked this file. It is not a claim
       * about what Node.js loads at runtime (for "./foo.js" TypeScript resolves the source "foo.ts").
       */
      readonly claim: "typescript-resolution";
      /** Resolved to a declaration file (.d.ts, .d.mts, .d.cts). */
      readonly declarationOnly: boolean;
      /** The specifier's extension differs from the resolved file's (e.g. ".js" → ".ts"). */
      readonly extensionSubstituted: boolean;
      /** Config that set the resolution options; absent when the no-config fallback was used. */
      readonly configPath?: RepoPath;
    }
  | { readonly status: "external"; readonly reason: "package" | "builtin" | "outside-repository" }
  | { readonly status: "unresolved"; readonly reason: "not-found" | "not-indexed" }
  | { readonly status: "ambiguous"; readonly candidates: readonly RepoPath[] }
  | { readonly status: "unsupported"; readonly reason: string };

export type ModuleResolutionStatus = ModuleResolution["status"];

export interface ModuleResolver {
  /**
   * Version of the resolution rules (adapter rules and engine version). Stored results with another
   * version are recomputed even when no file changed (TASK-008).
   */
  readonly version: string;
  resolve(request: ModuleResolutionRequest): ModuleResolution;
  /**
   * Repository config files that decide how specifiers in fromPath resolve: the nearest
   * tsconfig.json/jsconfig.json and the files it extends (inside the repository). Empty without a config.
   */
  configFiles(fromPath: RepoPath): readonly RepoPath[];
  /** Problems found while reading configuration (tsconfig.json / jsconfig.json). */
  readonly diagnostics: readonly Diagnostic[];
}
