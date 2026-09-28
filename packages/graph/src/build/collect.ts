/**
 * Facts for a full graph build (TASK-007): Project Truth, repository scan and fingerprints,
 * source analyses, Git state and history, and a TypeScript module resolver. Read-only. This is the
 * clean full build: it analyzes every file and keeps no state. The incremental Indexer (TASK-008)
 * produces the same GraphBuildInput with cached analyses.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createDefaultAnalyzerRegistry, fingerprintRepositoryFiles, openGitProvider, scanRepository,
  type AnalyzerRegistry,
} from "@duo-director/analyzer";
import { failure, loadProjectTruth, STATE_DIR_NAME, success, type Diagnostic, type ParseResult, type RepoPath } from "@duo-director/core";
import { createLanguageModuleResolver } from "./resolve/languages.js";
import { HISTORY_WINDOW, summarizeHistory } from "./history.js";
import type { AnalyzedFile, GraphBuildInput } from "./types.js";

export interface CollectOptions {
  /** Analyzers to use; default: the TypeScript/JavaScript registry (disposed after collection). */
  readonly registry?: AnalyzerRegistry;
  /** Commits read for co-change and Issue provenance. Default HISTORY_WINDOW (500, 04). */
  readonly maxCommits?: number;
}

export async function collectGraphFacts(root: string, options: CollectOptions = {}): Promise<ParseResult<GraphBuildInput>> {
  const rootDir = path.resolve(root);
  const diagnostics: Diagnostic[] = [];
  const loaded = loadProjectTruth(rootDir);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.value === undefined) return failure(diagnostics);
  const { truth, trace } = loaded.value;

  const scan = await scanRepository(rootDir, { include: truth.config.index.include, exclude: truth.config.index.exclude });
  diagnostics.push(...scan.diagnostics);
  if (scan.diagnostics.some((d) => d.severity === "error")) return failure(diagnostics);
  const fingerprinted = await fingerprintRepositoryFiles(rootDir, scan.files);
  diagnostics.push(...fingerprinted.diagnostics);

  let registry = options.registry;
  if (registry === undefined) {
    const created = await createDefaultAnalyzerRegistry();
    diagnostics.push(...created.diagnostics);
    if (created.value === undefined) return failure(diagnostics);
    registry = created.value;
  }
  const analyses: AnalyzedFile[] = [];
  const failedAnalyses: RepoPath[] = [];
  const texts = new Map<RepoPath, string>();
  try {
    const selection = registry.scope(fingerprinted.fingerprints.map((f) => f.path).filter((p) => !p.startsWith(`${STATE_DIR_NAME}/`)));
    for (const f of fingerprinted.fingerprints) {
      if (f.path.startsWith(`${STATE_DIR_NAME}/`)) continue;
      const analyzer = selection.analyzerFor(f.path);
      if (analyzer === undefined) continue;
      const content = fs.readFileSync(path.join(rootDir, f.path));
      const r = analyzer.analyze({ path: f.path, content });
      diagnostics.push(...r.diagnostics);
      if (r.value === undefined) {
        failedAnalyses.push(f.path);
        continue;
      }
      analyses.push({ analysis: r.value, analyzerVersion: analyzer.version, callResolution: analyzer.callResolution, capabilities: analyzer.capabilities });
      texts.set(f.path, content.toString("utf8"));
    }
  } finally {
    if (options.registry === undefined) registry.dispose();
  }

  const git = await openGitProvider(rootDir);
  diagnostics.push(...git.diagnostics);
  const state = git.value === undefined ? undefined : await git.value.repositoryState();
  const window = options.maxCommits ?? HISTORY_WINDOW;
  const commits = git.value === undefined || state?.value?.headOid === undefined ? undefined : await git.value.listCommits({ maxCommits: window });
  diagnostics.push(...(state?.diagnostics ?? []), ...(commits?.diagnostics ?? []));

  const indexedFiles = new Set(fingerprinted.fingerprints.map((f) => f.path).filter((p) => !p.startsWith(`${STATE_DIR_NAME}/`)));
  const moduleResolver = createLanguageModuleResolver({ root: rootDir, indexedFiles });
  return success({
    truth, trace, files: fingerprinted.fingerprints, analyses, failedAnalyses,
    sourceText: (p) => texts.get(p),
    moduleResolver,
    git: {
      ...(state?.value === undefined ? {} : { state: state.value }),
      ...(commits?.value === undefined ? {} : { history: summarizeHistory(commits.value, window) }),
    },
  }, diagnostics);
}
