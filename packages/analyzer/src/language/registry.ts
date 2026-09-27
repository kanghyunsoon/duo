/**
 * Analyzer registry (AC-005-04). Adding a language means registering another LanguageAnalyzer;
 * nothing else in DUO changes.
 */
import { createDiagnostic, failure, type ParseResult, type RepoPath } from "@duo-director/core";
import type { LanguageAnalyzer, SourceAnalysis, SourceInput } from "./types.js";

export interface AnalyzerRegistry {
  /** In registration order. */
  readonly analyzers: readonly LanguageAnalyzer[];
  /** The first registered analyzer that supports the path. */
  analyzerFor(path: RepoPath): LanguageAnalyzer | undefined;
  /** Analyzes with analyzerFor(path); LANGUAGE_UNSUPPORTED (no parse) when there is none. */
  analyze(input: SourceInput): ParseResult<SourceAnalysis>;
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
  return {
    analyzers: list,
    analyzerFor,
    analyze(input) {
      const analyzer = analyzerFor(input.path);
      if (analyzer === undefined) {
        return failure([createDiagnostic("LANGUAGE_UNSUPPORTED", `No language analyzer supports "${input.path}"`, { path: input.path })]);
      }
      return analyzer.analyze(input);
    },
    dispose() {
      for (const a of list) a.dispose();
    },
  };
}
