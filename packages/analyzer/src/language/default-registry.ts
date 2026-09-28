/**
 * The default analyzer registry (T18.0): TypeScript, JavaScript, Java, C#, C++, Python. Every grammar
 * loads once when the registry is created and is reused for every file. The caller disposes it.
 */
import { failure, success, type ParseResult } from "@duo-director/core";
import { createAnalyzerRegistry, type AnalyzerRegistry } from "./registry.js";
import type { TreeSitterAnalyzerOptions } from "./tree-sitter/analyzer-base.js";
import {
  CPP_SPEC, createCppAnalyzer, createCSharpAnalyzer, createJavaAnalyzer, createPythonAnalyzer, CSHARP_SPEC, JAVA_SPEC, PYTHON_SPEC,
} from "./tree-sitter/languages.js";
import {
  createJavaScriptAnalyzer, createTypeScriptAnalyzer, JAVASCRIPT_EXTENSIONS, TS_JS_CAPABILITIES, TYPESCRIPT_EXTENSIONS,
} from "./tree-sitter/ts-js-analyzer.js";
import type { AnalyzerCapabilities, CallResolutionStrategy } from "./types.js";

/** What the default analyzer of a language can do, as data (Context and Review read it from a file's language). */
export interface LanguageProfile {
  readonly analyzer: string;
  readonly capabilities: AnalyzerCapabilities;
  readonly callResolution: CallResolutionStrategy;
}

const ts: LanguageProfile = { analyzer: "typescript", capabilities: TS_JS_CAPABILITIES, callResolution: "module-bindings" };
/** Language (SourceAnalysis.language) → profile of the default registry's analyzer for it. */
export const DEFAULT_LANGUAGE_PROFILES: Readonly<Record<string, LanguageProfile>> = {
  typescript: ts, tsx: ts, javascript: { ...ts, analyzer: "javascript" },
  java: { analyzer: JAVA_SPEC.id, capabilities: JAVA_SPEC.capabilities, callResolution: JAVA_SPEC.callResolution },
  csharp: { analyzer: CSHARP_SPEC.id, capabilities: CSHARP_SPEC.capabilities, callResolution: CSHARP_SPEC.callResolution },
  cpp: { analyzer: CPP_SPEC.id, capabilities: CPP_SPEC.capabilities, callResolution: CPP_SPEC.callResolution },
  python: { analyzer: PYTHON_SPEC.id, capabilities: PYTHON_SPEC.capabilities, callResolution: PYTHON_SPEC.callResolution },
};

/** The default profile of a file's language; undefined for a generic (file-only) file or an unknown language. */
export const languageProfile = (language: unknown): LanguageProfile | undefined =>
  typeof language === "string" && Object.hasOwn(DEFAULT_LANGUAGE_PROFILES, language) ? DEFAULT_LANGUAGE_PROFILES[language] : undefined;

/**
 * Extension → language of the default registry, for a path that has symbols or tests in the graph
 * (so a ".h" file with symbols is C++ by the header rule).
 */
export const DEFAULT_EXTENSION_LANGUAGES: Readonly<Record<string, string>> = Object.fromEntries([
  ...Object.entries(TYPESCRIPT_EXTENSIONS), ...Object.entries(JAVASCRIPT_EXTENSIONS),
  ...[JAVA_SPEC, CSHARP_SPEC, CPP_SPEC, PYTHON_SPEC].flatMap((s) => [...Object.entries(s.extensions), ...Object.entries(s.contextual ?? {})]),
]);

export async function createDefaultAnalyzerRegistry(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<AnalyzerRegistry>> {
  const made = await Promise.all([
    createTypeScriptAnalyzer(options), createJavaScriptAnalyzer(options), createJavaAnalyzer(options),
    createCSharpAnalyzer(options), createCppAnalyzer(options), createPythonAnalyzer(options),
  ]);
  if (made.some((m) => m.value === undefined)) {
    for (const m of made) m.value?.dispose();
    return failure(made.flatMap((m) => m.diagnostics));
  }
  return success(createAnalyzerRegistry(made.map((m) => m.value as NonNullable<typeof m.value>)));
}
