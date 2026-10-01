/**
 * One LanguageAnalyzer implementation for every Tree-sitter language (TASK-005, T18.0): the spec
 * names the grammars per extension, the extractor and the capabilities. Grammars load once per
 * analyzer; one Parser per grammar is reused for every file; a file is parsed once and its tree
 * deleted right after extraction. Unsupported paths are never parsed. Source text is the canonical
 * text (T09.1: normalized line endings, one leading BOM removed), so locations address sliceSource().
 */
import { createHash } from "node:crypto";
import { createDiagnostic, failure, success, type ParseResult, type RepoPath } from "@duo-director/core";
import type { Parser, Tree } from "web-tree-sitter";
import { canonicalContent, computeContentHash } from "../../fingerprint/content-hash.js";
import { fingerprintModeOf } from "../../fingerprint/fingerprint-mode.js";
import {
  CAPABILITY_CONTRACT_VERSION, type AnalyzerCapabilities, type CallResolutionStrategy, type LanguageAnalyzer, type SourceAnalysis, type SourceInput, type SourceLanguage,
} from "../types.js";
import { createParser, defaultGrammarLocator, loadGrammarSet, type GrammarId, type GrammarLocator } from "./runtime.js";
import type { Extraction } from "./syntax.js";

/** Per-file parse limit (docs/10-security.md). */
export const DEFAULT_PARSE_TIMEOUT_MS = 2000;

export interface TreeSitterAnalyzerOptions {
  /** Where to load grammar WASM from. Default: packaged grammars, then the grammar packages. */
  readonly locateGrammar?: GrammarLocator;
  readonly parseTimeoutMs?: number;
}

export interface TreeSitterAnalyzerSpec {
  readonly id: string;
  readonly version: string;
  /** Extension (lowercase, no dot) → grammar. The grammar ID is the SourceAnalysis language. */
  readonly extensions: Readonly<Record<string, GrammarId>>;
  /** Extensions accepted only when the registry decides them for this analyzer (C++ ".h"). */
  readonly contextual?: Readonly<Record<string, GrammarId>>;
  readonly capabilities: AnalyzerCapabilities;
  readonly callResolution: CallResolutionStrategy;
  /** Text rewrite of the same length before parsing (C++ masks known annotation macros); locations stay exact. */
  readonly prepare?: (text: string) => string;
  /**
   * Version of facts outside the Graph payload (C++: callable signatures, T24.3). Part of the identity, so
   * cached analyses are made again when it changes; `version` (the Symbol payload's analyzerVersion) stays.
   */
  readonly facts?: string;
  readonly extract: (path: RepoPath, tree: Tree, text: string) => Extraction;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function extensionOf(path: RepoPath): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** sha256 over the canonical identity fields (sorted keys and lists). */
export function analyzerIdentity(spec: TreeSitterAnalyzerSpec, grammarDigests: ReadonlyMap<GrammarId, string>): string {
  const grammars = [...new Set([...Object.values(spec.extensions), ...Object.values(spec.contextual ?? {})])].sort()
    .map((g) => `${g}=${grammarDigests.get(g) ?? "missing"}`);
  const caps = Object.entries(spec.capabilities).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${String(v)}`);
  const parts = [
    `id=${spec.id}`, `version=${spec.version}`, `capabilities-contract=${CAPABILITY_CONTRACT_VERSION}`,
    `extensions=${Object.keys(spec.extensions).sort().join(",")}`, `contextual=${Object.keys(spec.contextual ?? {}).sort().join(",")}`,
    `calls=${spec.callResolution}`, ...caps, ...grammars, ...(spec.facts === undefined ? [] : [`facts=${spec.facts}`]),
  ];
  return `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

class TreeSitterAnalyzer implements LanguageAnalyzer {
  private disposed = false;
  readonly id: string;
  readonly version: string;
  readonly languages: readonly SourceLanguage[];
  readonly extensions: readonly string[];
  readonly contextualExtensions: readonly string[];
  readonly capabilities: AnalyzerCapabilities;
  readonly callResolution: CallResolutionStrategy;

  constructor(
    private readonly spec: TreeSitterAnalyzerSpec,
    private readonly parsers: ReadonlyMap<GrammarId, Parser>,
    private readonly parseTimeoutMs: number,
    readonly identity: string,
  ) {
    this.id = spec.id;
    this.version = spec.version;
    this.languages = [...new Set([...Object.values(spec.extensions), ...Object.values(spec.contextual ?? {})])].sort();
    this.extensions = Object.keys(spec.extensions).sort();
    this.contextualExtensions = Object.keys(spec.contextual ?? {}).sort();
    this.capabilities = spec.capabilities;
    this.callResolution = spec.callResolution;
  }

  private grammarOf(path: RepoPath): GrammarId | undefined {
    const ext = extensionOf(path);
    if (Object.hasOwn(this.spec.extensions, ext)) return this.spec.extensions[ext];
    return this.spec.contextual !== undefined && Object.hasOwn(this.spec.contextual, ext) ? this.spec.contextual[ext] : undefined;
  }

  supports(path: RepoPath): boolean {
    return Object.hasOwn(this.spec.extensions, extensionOf(path));
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
      // Canonical source text (T09.1): CRLF is already LF in the canonical bytes; a leading BOM is removed so
      // every location addresses the same text as sliceSource().
      text = decoder.decode(canonicalContent(input.content, mode));
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    } catch {
      return failure([createDiagnostic("SOURCE_DECODE_ERROR", `"${path}" is not valid UTF-8`, { path })]);
    }
    const parsed = this.spec.prepare === undefined ? text : this.spec.prepare(text);
    if (parsed.length !== text.length) throw new Error(`${this.id}: prepare() must keep the text length`);
    const deadline = performance.now() + this.parseTimeoutMs;
    const tree = parser.parse(parsed, null, { progressCallback: () => performance.now() > deadline });
    if (tree === null) {
      parser.reset();
      return failure([createDiagnostic("AST_PARSE_TIMEOUT", `Parsing "${path}" took longer than ${this.parseTimeoutMs} ms`, { path })]);
    }
    try {
      const x = this.spec.extract(path, tree, text);
      return success({
        path, language: grammar, contentHash, parseStatus: x.partial ? "partial" : "complete",
        symbols: x.symbols, moduleReferences: x.moduleReferences, exports: x.exports, callSites: x.callSites, annotations: x.annotations, tests: x.tests,
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

export async function createTreeSitterAnalyzer(spec: TreeSitterAnalyzerSpec, options: TreeSitterAnalyzerOptions = {}): Promise<ParseResult<LanguageAnalyzer>> {
  const grammars = [...new Set([...Object.values(spec.extensions), ...Object.values(spec.contextual ?? {})])].sort();
  const loaded = await loadGrammarSet(grammars, options.locateGrammar ?? defaultGrammarLocator);
  if (loaded.value === undefined) return failure(loaded.diagnostics);
  const parsers = new Map([...loaded.value.languages].map(([g, language]) => [g, createParser(language)] as const));
  return success(new TreeSitterAnalyzer(spec, parsers, options.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS, analyzerIdentity(spec, loaded.value.digests)));
}
