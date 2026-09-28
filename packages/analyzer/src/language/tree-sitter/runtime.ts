/**
 * web-tree-sitter runtime and grammar loading (TASK-005, ADR-003). The only module besides the
 * extractor that imports web-tree-sitter (scripts/boundaries.json treeSitter). Grammars are the WASM
 * files shipped in the official tree-sitter-typescript and tree-sitter-javascript packages.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult } from "@duo-director/core";
import { Language, LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION, Parser } from "web-tree-sitter";

export type GrammarId = "typescript" | "tsx" | "javascript" | "java" | "csharp" | "cpp" | "python";

/** Package-relative WASM file of each grammar. */
export const GRAMMAR_FILES: Readonly<Record<GrammarId, string>> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  csharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};

/** Returns the WASM file path (or bytes) of a grammar. Tests pass their own to exercise failures. */
export type GrammarLocator = (id: GrammarId) => string | Uint8Array;

const requireFromHere = createRequire(import.meta.url);

/** File name of each grammar inside a packaged DUO (the published CLI vendors them in grammars/ next to the bundle, T17.1). */
const fileName = (id: GrammarId) => GRAMMAR_FILES[id].slice(GRAMMAR_FILES[id].lastIndexOf("/") + 1);

/**
 * Packaged grammars first (grammars/<file>.wasm beside this module: the published @duo-director/cli,
 * which does not depend on the grammar npm packages and their native install scripts), then the
 * grammar packages (the development workspace).
 */
export const defaultGrammarLocator: GrammarLocator = (id) => {
  const packaged = fileURLToPath(new URL(`./grammars/${fileName(id)}`, import.meta.url));
  if (fs.existsSync(packaged)) return packaged;
  try {
    return requireFromHere.resolve(GRAMMAR_FILES[id]);
  } catch {
    throw new Error(`the grammar asset ${fileName(id)} is missing from this DUO installation (looked in ${packaged}); reinstall the @duo-director/cli package`);
  }
};

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
  const r = await loadGrammarSet(ids, locate);
  return r.value === undefined ? failure(r.diagnostics) : success(r.value.languages);
}

export interface LoadedGrammars {
  readonly languages: Map<GrammarId, Language>;
  /** sha256 of each grammar's WASM bytes: part of the analyzer identity (a new grammar build re-analyzes its files). */
  readonly digests: Map<GrammarId, string>;
}

export async function loadGrammarSet(ids: readonly GrammarId[], locate: GrammarLocator = defaultGrammarLocator): Promise<ParseResult<LoadedGrammars>> {
  try {
    await initRuntime();
  } catch (error) {
    return failure([createDiagnostic("ANALYZER_INIT_FAILED", `web-tree-sitter runtime failed to initialize: ${message(error)}`)]);
  }
  const languages = new Map<GrammarId, Language>();
  const digests = new Map<GrammarId, string>();
  const diagnostics: Diagnostic[] = [];
  for (const id of ids) {
    let source: Uint8Array;
    try {
      const located = locate(id);
      source = typeof located === "string" ? new Uint8Array(fs.readFileSync(located)) : located;
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
      digests.set(id, createHash("sha256").update(source).digest("hex"));
    } catch (error) {
      diagnostics.push(createDiagnostic("ANALYZER_INIT_FAILED",
        `Grammar "${id}" could not be loaded (web-tree-sitter ABI ${MIN_COMPATIBLE_VERSION}..${LANGUAGE_VERSION}): ${message(error)}`));
    }
  }
  return diagnostics.length > 0 ? failure(diagnostics) : success({ languages, digests });
}

/** A parser bound to one language. The caller deletes it. */
export function createParser(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
