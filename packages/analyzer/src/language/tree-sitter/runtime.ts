/**
 * web-tree-sitter runtime and grammar loading (TASK-005, ADR-003). The only module besides the
 * extractor that imports web-tree-sitter (scripts/boundaries.json treeSitter). Grammars are the WASM
 * files shipped in the official tree-sitter-typescript and tree-sitter-javascript packages.
 */
import { createRequire } from "node:module";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult } from "@duo-director/core";
import { Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser } from "web-tree-sitter";

export type GrammarId = "typescript" | "tsx" | "javascript";

/** Package-relative WASM file of each grammar. */
export const GRAMMAR_FILES: Readonly<Record<GrammarId, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

/** Returns the WASM file path (or bytes) of a grammar. Tests pass their own to exercise failures. */
export type GrammarLocator = (id: GrammarId) => string | Uint8Array;

const requireFromHere = createRequire(import.meta.url);
export const defaultGrammarLocator: GrammarLocator = (id) => requireFromHere.resolve(GRAMMAR_FILES[id]);

/**
 * web-tree-sitter keeps one WASM runtime per process, so it is initialized once and never
 * reconfigured. Languages and parsers are not global: each analyzer owns its own.
 */
let runtimeReady: Promise<void> | undefined;

function initRuntime(): Promise<void> {
  runtimeReady ??= Parser.init().catch((error: unknown) => {
    runtimeReady = undefined;
    throw error;
  });
  return runtimeReady;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** ABI range of the loaded runtime. Valid after the first loadGrammars(). */
export function runtimeAbiRange(): { readonly min: number; readonly max: number } {
  return { min: MIN_COMPATIBLE_VERSION, max: LANGUAGE_VERSION };
}

/** Initializes the runtime (once) and loads each grammar. Any failure is ANALYZER_INIT_FAILED. */
export async function loadGrammars(ids: readonly GrammarId[], locate: GrammarLocator = defaultGrammarLocator): Promise<ParseResult<Map<GrammarId, Language>>> {
  try {
    await initRuntime();
  } catch (error) {
    return failure([createDiagnostic("ANALYZER_INIT_FAILED", `web-tree-sitter runtime failed to initialize: ${message(error)}`)]);
  }
  const languages = new Map<GrammarId, Language>();
  const diagnostics: Diagnostic[] = [];
  for (const id of ids) {
    let source: string | Uint8Array;
    try {
      source = locate(id);
    } catch (error) {
      diagnostics.push(createDiagnostic("ANALYZER_INIT_FAILED", `Grammar "${id}" (${GRAMMAR_FILES[id]}) not found: ${message(error)}`));
      continue;
    }
    try {
      const language = await Language.load(source);
      const abi = language.abiVersion;
      if (abi < MIN_COMPATIBLE_VERSION || abi > LANGUAGE_VERSION) {
        diagnostics.push(createDiagnostic("ANALYZER_INIT_FAILED",
          `Grammar "${id}" has ABI ${abi}; web-tree-sitter supports ${MIN_COMPATIBLE_VERSION}..${LANGUAGE_VERSION}`));
        continue;
      }
      languages.set(id, language);
    } catch (error) {
      diagnostics.push(createDiagnostic("ANALYZER_INIT_FAILED",
        `Grammar "${id}" could not be loaded (web-tree-sitter ABI ${MIN_COMPATIBLE_VERSION}..${LANGUAGE_VERSION}): ${message(error)}`));
    }
  }
  return diagnostics.length > 0 ? failure(diagnostics) : success(languages);
}

/** A parser bound to one language. The caller deletes it. */
export function createParser(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
