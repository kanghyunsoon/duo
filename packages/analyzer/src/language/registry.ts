/**
 * Analyzer registry (AC-005-04, T18.0). Adding a language means registering another LanguageAnalyzer;
 * the Indexer, Graph Builder, Context Compiler and Review do not change. Selection is per file, never
 * per project: a polyglot repository gets the right analyzer for each file, and a file no analyzer
 * claims is a generic file (L0: file, fingerprint, Git, diff, Truth references) with FILE_ONLY
 * capabilities.
 *
 * Contextual extensions: ".h" is C or C++. The registry decides it from the repository's file set
 * (header rule): C++ when the repository has a *.uproject, when a C++ source with the same stem sits
 * next to it, or when it has C++ sources and no C sources. Otherwise the header stays a generic file
 * (no false certainty).
 */
import { createHash } from "node:crypto";
import { createDiagnostic, failure, type ParseResult, type RepoPath } from "@duo-director/core";
import { FILE_ONLY_CAPABILITIES, type AnalyzerCapabilities, type LanguageAnalyzer, type SourceAnalysis, type SourceInput, type SourceLanguage } from "./types.js";

/** Version of the selection rules above (part of the registry digest). */
export const ANALYZER_SELECTION_VERSION = "1";

const CPP_SOURCES = new Set(["cpp", "cc", "cxx"]);
const CPP_FILES = new Set(["cpp", "cc", "cxx", "hpp", "hh", "hxx"]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
const stemOf = (path: string) => path.slice(0, path.length - extensionOf(path).length - 1);

/** Repository facts the header rule needs. */
export interface HeaderContext {
  readonly uproject: boolean;
  readonly cppProject: boolean;
  readonly cppStems: ReadonlySet<string>;
}

export function headerContext(paths: readonly string[]): HeaderContext {
  const exts = paths.map(extensionOf);
  return {
    uproject: exts.includes("uproject"),
    cppProject: exts.some((e) => CPP_FILES.has(e)) && !exts.includes("c"),
    cppStems: new Set(paths.filter((p) => CPP_SOURCES.has(extensionOf(p))).map(stemOf)),
  };
}

/** The header rule: a ".h" file is C++ with repository evidence, otherwise it stays a generic file. */
export function isCppHeader(path: string, context: HeaderContext): boolean {
  return extensionOf(path) === "h" && (context.uproject || context.cppProject || context.cppStems.has(stemOf(path)));
}

/** The analyzers chosen for one repository's file set. */
export interface AnalyzerSelection {
  analyzerFor(path: RepoPath): LanguageAnalyzer | undefined;
  /** The analyzer's capabilities, or FILE_ONLY for a generic file. */
  capabilitiesFor(path: RepoPath): AnalyzerCapabilities;
  /** Language of a file: its analyzer's language, or undefined for a generic file. */
  languageFor(path: RepoPath): SourceLanguage | undefined;
}

export interface AnalyzerRegistry {
  /** In registration order. */
  readonly analyzers: readonly LanguageAnalyzer[];
  /** The first analyzer whose own extensions claim the path (contextual extensions need scope()). */
  analyzerFor(path: RepoPath): LanguageAnalyzer | undefined;
  /** Selection with the repository context (every indexed path). */
  scope(paths: readonly RepoPath[]): AnalyzerSelection;
  /** Analyzes with analyzerFor(path); LANGUAGE_UNSUPPORTED (no parse) when there is none. */
  analyze(input: SourceInput): ParseResult<SourceAnalysis>;
  /** Analyzer ID → identity. */
  identities(): Readonly<Record<string, string>>;
  /** sha256 of every analyzer identity and the selection rules: changes when any analyzer is added, removed or changed. */
  digest(): string;
  /** Disposes every analyzer. */
  dispose(): void;
}

export function createAnalyzerRegistry(analyzers: readonly LanguageAnalyzer[]): AnalyzerRegistry {
  const ids = new Set<string>();
  for (const a of analyzers) {
    if (ids.has(a.id)) throw new Error(`Duplicate LanguageAnalyzer id "${a.id}"`);
    ids.add(a.id);
  }
  const list = [...analyzers];
  const analyzerFor = (path: RepoPath) => list.find((a) => a.supports(path));
  const identities = Object.fromEntries(list.map((a) => [a.id, a.identity] as const).sort(([x], [y]) => (x < y ? -1 : 1)));
  const digest = `sha256:${createHash("sha256").update([`selection=${ANALYZER_SELECTION_VERSION}`, ...Object.entries(identities).map(([k, v]) => `${k}=${v}`)].join("\n")).digest("hex")}`;
  return {
    analyzers: list,
    analyzerFor,
    scope(paths) {
      const context = headerContext(paths);
      const selectFor = (path: RepoPath): LanguageAnalyzer | undefined => {
        const own = analyzerFor(path);
        if (own !== undefined) return own;
        const ext = extensionOf(path);
        const contextual = list.find((a) => a.contextualExtensions?.includes(ext));
        if (contextual === undefined || ext !== "h") return undefined;
        return isCppHeader(path, context) ? contextual : undefined;
      };
      return {
        analyzerFor: selectFor,
        capabilitiesFor: (path) => selectFor(path)?.capabilities ?? FILE_ONLY_CAPABILITIES,
        languageFor(path) {
          const a = selectFor(path);
          if (a === undefined) return undefined;
          return a.languages.length === 1 ? a.languages[0] : undefined;
        },
      };
    },
    analyze(input) {
      const analyzer = analyzerFor(input.path);
      if (analyzer === undefined) {
        return failure([createDiagnostic("LANGUAGE_UNSUPPORTED", `No language analyzer supports "${input.path}"`, { path: input.path })]);
      }
      return analyzer.analyze(input);
    },
    identities: () => identities,
    digest: () => digest,
    dispose() {
      for (const a of list) a.dispose();
    },
  };
}

export interface AnalyzerDescription {
  readonly id: string;
  readonly version: string;
  readonly identity: string;
  readonly languages: readonly SourceLanguage[];
  readonly extensions: readonly string[];
  readonly contextualExtensions: readonly string[];
  readonly capabilities: AnalyzerCapabilities;
}

/** The registry's analyzers as data (status, coverage, adoption baseline). */
export function describeAnalyzers(registry: AnalyzerRegistry): AnalyzerDescription[] {
  return registry.analyzers.map((a) => ({
    id: a.id, version: a.version, identity: a.identity, languages: [...a.languages], extensions: [...a.extensions], contextualExtensions: [...(a.contextualExtensions ?? [])], capabilities: a.capabilities,
  }));
}
