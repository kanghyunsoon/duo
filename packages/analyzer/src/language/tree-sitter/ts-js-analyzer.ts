/**
 * TypeScriptAnalyzer and JavaScriptAnalyzer (TASK-005, ADR-003) on the shared Tree-sitter analyzer
 * (analyzer-base.ts). Extraction is ts-js-extract.ts.
 */
import type { ParseResult } from "@duo-director/core";
import type { AnalyzerCapabilities, LanguageAnalyzer } from "../types.js";
import { createTreeSitterAnalyzer, DEFAULT_PARSE_TIMEOUT_MS, type TreeSitterAnalyzerOptions } from "./analyzer-base.js";
import type { GrammarId } from "./runtime.js";
import { extractTypeScriptJavaScript } from "./ts-js-extract.js";

export { DEFAULT_PARSE_TIMEOUT_MS, type TreeSitterAnalyzerOptions };

/** Extension (lowercase, without the dot) → grammar. */
export const TYPESCRIPT_EXTENSIONS: Readonly<Record<string, GrammarId>> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx" };
export const JAVASCRIPT_EXTENSIONS: Readonly<Record<string, GrammarId>> = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript" };

/**
 * Bump when extraction output changes (04: a new version re-analyzes that analyzer's files).
 * 2: T05.1 static member identity, import bindings, tests. 3: T07 local exports and call structure.
 */
export const TS_JS_ANALYZER_VERSION = "4";

/**
 * L1 plus the L2 parts DUO has: every module specifier is decided by TypeScript's module resolution;
 * CALLS edges exist where import bindings, the export index or this-members make the target certain
 * (partial: receiver types are not checked, so an unresolved call is not an absent call).
 */
export const TS_JS_CAPABILITIES: AnalyzerCapabilities = { files: true, symbols: "structural", tests: "structural", imports: "resolved", calls: "partial", typeResolution: "none" };

function spec(id: string, extensions: Readonly<Record<string, GrammarId>>) {
  return { id, version: TS_JS_ANALYZER_VERSION, extensions, capabilities: TS_JS_CAPABILITIES, callResolution: "module-bindings" as const, extract: extractTypeScriptJavaScript };
}

/** .ts .mts .cts (TypeScript grammar) and .tsx (TSX grammar). */
export function createTypeScriptAnalyzer(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> {
  return createTreeSitterAnalyzer(spec("typescript", TYPESCRIPT_EXTENSIONS), options);
}

/** .js .mjs .cjs .jsx (JavaScript grammar, which includes JSX). */
export function createJavaScriptAnalyzer(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> {
  return createTreeSitterAnalyzer(spec("javascript", JAVASCRIPT_EXTENSIONS), options);
}
