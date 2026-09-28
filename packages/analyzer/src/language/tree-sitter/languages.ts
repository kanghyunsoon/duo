/**
 * The structural analyzers for Java, C#, C++ and Python (T18.0) on the shared Tree-sitter analyzer.
 * L1 for each: symbols, tests, imports as written, call sites; resolution only where syntax makes it
 * certain (capabilities say how far).
 */
import type { ParseResult } from "@duo-director/core";
import type { AnalyzerCapabilities, LanguageAnalyzer } from "../types.js";
import { createTreeSitterAnalyzer, type TreeSitterAnalyzerOptions, type TreeSitterAnalyzerSpec } from "./analyzer-base.js";
import { extractCpp, maskCppAnnotationMacros } from "./cpp-extract.js";
import { extractCSharp } from "./csharp-extract.js";
import { extractJava } from "./java-extract.js";
import { extractPython } from "./python-extract.js";

/** Java and C#: imports/usings as written (no classpath, MSBuild or NuGet); call sites without CALLS edges. */
export const JAVA_CSHARP_CAPABILITIES: AnalyzerCapabilities = { files: true, symbols: "structural", tests: "structural", imports: "syntactic", calls: "syntactic", typeResolution: "none" };
/** C++: quoted includes next to the including file resolve; CALLS only for a bare call from a free function to the only same-file function of that name. */
export const CPP_CAPABILITIES: AnalyzerCapabilities = { files: true, symbols: "structural", tests: "structural", imports: "partial", calls: "partial", typeResolution: "none" };
/** Python: relative and same-repository absolute imports resolve; CALLS only for a bare call to the only same-module function of that name. */
export const PYTHON_CAPABILITIES: AnalyzerCapabilities = { files: true, symbols: "structural", tests: "structural", imports: "partial", calls: "partial", typeResolution: "none" };

export const JAVA_ANALYZER_VERSION = "1";
export const CSHARP_ANALYZER_VERSION = "1";
/** 1: T18.0, Unreal annotation macros masked. */
export const CPP_ANALYZER_VERSION = "1";
export const PYTHON_ANALYZER_VERSION = "1";

export const JAVA_SPEC: TreeSitterAnalyzerSpec = {
  id: "java", version: JAVA_ANALYZER_VERSION, extensions: { java: "java" }, capabilities: JAVA_CSHARP_CAPABILITIES, callResolution: "none", extract: extractJava,
};
export const CSHARP_SPEC: TreeSitterAnalyzerSpec = {
  id: "csharp", version: CSHARP_ANALYZER_VERSION, extensions: { cs: "csharp" }, capabilities: JAVA_CSHARP_CAPABILITIES, callResolution: "none", extract: extractCSharp,
};
export const CPP_SPEC: TreeSitterAnalyzerSpec = {
  id: "cpp", version: CPP_ANALYZER_VERSION,
  extensions: { cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp" },
  // ".h" is C or C++: the registry decides from the repository (C18.0 header rule).
  contextual: { h: "cpp" },
  capabilities: CPP_CAPABILITIES, callResolution: "same-file-functions", prepare: maskCppAnnotationMacros, extract: extractCpp,
};
export const PYTHON_SPEC: TreeSitterAnalyzerSpec = {
  id: "python", version: PYTHON_ANALYZER_VERSION, extensions: { py: "python" }, capabilities: PYTHON_CAPABILITIES, callResolution: "same-file-functions", extract: extractPython,
};

export const createJavaAnalyzer = (o: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> => createTreeSitterAnalyzer(JAVA_SPEC, o);
export const createCSharpAnalyzer = (o: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> => createTreeSitterAnalyzer(CSHARP_SPEC, o);
export const createCppAnalyzer = (o: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> => createTreeSitterAnalyzer(CPP_SPEC, o);
export const createPythonAnalyzer = (o: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> => createTreeSitterAnalyzer(PYTHON_SPEC, o);
