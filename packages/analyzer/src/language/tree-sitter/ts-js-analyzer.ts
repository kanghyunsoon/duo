/**
 * TypeScriptAnalyzer and JavaScriptAnalyzer (TASK-005, ADR-003) on web-tree-sitter. Each analyzer
 * loads its grammars once and keeps one Parser per grammar; every file is parsed once and its tree
 * is deleted right after extraction. Unsupported paths are never parsed.
 */
import {
  createDiagnostic, failure, success, type ParseResult, type RepoPath,
} from "@duo-director/core";
import type { Parser } from "web-tree-sitter";
import { canonicalContent, computeContentHash } from "../../fingerprint/content-hash.js";
import { fingerprintModeOf } from "../../fingerprint/fingerprint-mode.js";
import { createAnalyzerRegistry, type AnalyzerRegistry } from "../registry.js";
import type { LanguageAnalyzer, SourceAnalysis, SourceInput } from "../types.js";
import { createParser, defaultGrammarLocator, loadGrammars, type GrammarId, type GrammarLocator } from "./runtime.js";
import { extractTypeScriptJavaScript } from "./ts-js-extract.js";

/** Extension (lowercase, without the dot) → grammar. */
export const TYPESCRIPT_EXTENSIONS: Readonly<Record<string, GrammarId>> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx" };
export const JAVASCRIPT_EXTENSIONS: Readonly<Record<string, GrammarId>> = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript" };

/** Bump when extraction output changes (04: a new version re-analyzes that analyzer's files). */
export const TS_JS_ANALYZER_VERSION = "1";
/** Per-file parse limit (docs/10-security.md). */
export const DEFAULT_PARSE_TIMEOUT_MS = 2000;

export interface TreeSitterAnalyzerOptions {
  /** Where to load grammar WASM from. Default: the official grammar packages. */
  readonly locateGrammar?: GrammarLocator;
  readonly parseTimeoutMs?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function extensionOf(path: RepoPath): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

class TreeSitterAnalyzer implements LanguageAnalyzer {
  private disposed = false;

  constructor(
    readonly id: string,
    readonly version: string,
    private readonly extensions: Readonly<Record<string, GrammarId>>,
    private readonly parsers: ReadonlyMap<GrammarId, Parser>,
    private readonly parseTimeoutMs: number,
  ) {}

  private grammarOf(path: RepoPath): GrammarId | undefined {
    return Object.hasOwn(this.extensions, extensionOf(path)) ? this.extensions[extensionOf(path)] : undefined;
  }

  supports(path: RepoPath): boolean {
    return this.grammarOf(path) !== undefined;
  }

  analyze(input: SourceInput): ParseResult<SourceAnalysis> {
    if (this.disposed) throw new Error(`LanguageAnalyzer "${this.id}" was disposed`);
    const { path } = input;
    const grammar = this.grammarOf(path);
    const parser = grammar === undefined ? undefined : this.parsers.get(grammar);
    if (grammar === undefined || parser === undefined) {
      return failure([createDiagnostic("LANGUAGE_UNSUPPORTED", `"${path}" is not a ${this.id} source file`, { path })]);
    }
    // Same canonical bytes and hash as the fingerprint: source extensions are normalized-text.
    const mode = fingerprintModeOf(path);
    const { contentHash } = computeContentHash(input.content, mode);
    let text: string;
    try {
      text = decoder.decode(canonicalContent(input.content, mode));
    } catch {
      return failure([createDiagnostic("SOURCE_DECODE_ERROR", `"${path}" is not valid UTF-8`, { path })]);
    }
    const deadline = performance.now() + this.parseTimeoutMs;
    const tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
    if (tree === null) {
      parser.reset();
      return failure([createDiagnostic("AST_PARSE_TIMEOUT", `Parsing "${path}" took longer than ${this.parseTimeoutMs} ms`, { path })]);
    }
    try {
      const x = extractTypeScriptJavaScript(path, tree);
      return success({
        path,
        language: grammar,
        contentHash,
        parseStatus: x.partial ? "partial" : "complete",
        symbols: x.symbols,
        moduleReferences: x.moduleReferences,
        callSites: x.callSites,
        annotations: x.annotations,
      }, x.diagnostics);
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const parser of this.parsers.values()) parser.delete();
  }
}

async function createAnalyzer(
  id: string,
  extensions: Readonly<Record<string, GrammarId>>,
  options: TreeSitterAnalyzerOptions,
): Promise<ParseResult<LanguageAnalyzer>> {
  const grammars = [...new Set(Object.values(extensions))].sort();
  const loaded = await loadGrammars(grammars, options.locateGrammar ?? defaultGrammarLocator);
  if (loaded.value === undefined) return failure(loaded.diagnostics);
  const parsers = new Map([...loaded.value].map(([g, language]) => [g, createParser(language)] as const));
  return success(new TreeSitterAnalyzer(id, TS_JS_ANALYZER_VERSION, extensions, parsers, options.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS));
}

/** .ts .mts .cts (TypeScript grammar) and .tsx (TSX grammar). */
export function createTypeScriptAnalyzer(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> {
  return createAnalyzer("typescript", TYPESCRIPT_EXTENSIONS, options);
}

/** .js .mjs .cjs .jsx (JavaScript grammar, which includes JSX). */
export function createJavaScriptAnalyzer(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> {
  return createAnalyzer("javascript", JAVASCRIPT_EXTENSIONS, options);
}

/** Registry with the MVP analyzers (TypeScript, JavaScript). The caller disposes it. */
export async function createDefaultAnalyzerRegistry(options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<AnalyzerRegistry>> {
  const [ts, js] = await Promise.all([createTypeScriptAnalyzer(options), createJavaScriptAnalyzer(options)]);
  if (ts.value === undefined || js.value === undefined) {
    ts.value?.dispose();
    js.value?.dispose();
    return failure([...ts.diagnostics, ...js.diagnostics]);
  }
  return success(createAnalyzerRegistry([ts.value, js.value]));
}
