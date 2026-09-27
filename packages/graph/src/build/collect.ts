/**
 * Facts for a full graph build (TASK-007): Project Truth, repository scan and fingerprints,
 * source analyses, Git state and history, and a TypeScript module resolver. Read-only; the
 * incremental Indexer (TASK-008) will reuse the same pieces for affected files only.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createDefaultAnalyzerRegistry, fingerprintRepositoryFiles, openGitProvider, scanRepository,
  type AnalyzerRegistry,
} from "@duo-director/analyzer";
import { failure, loadProjectTruth, STATE_DIR_NAME, success, type Diagnostic, type ParseResult, type RepoPath } from "@duo-director/core";
import { createTypeScriptModuleResolver } from "./resolve/typescript/typescript-module-resolver.js";
import type { AnalyzedFile, GraphBuildInput } from "./types.js";

export interface CollectOptions {
  /** Analyzers to use; default: the TypeScript/JavaScript registry (disposed after collection). */
  readonly registry?: AnalyzerRegistry;
  /** Commits read for co-change and Issue provenance. Default 500 (04). */
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
    for (const f of fingerprinted.fingerprints) {
      if (f.path.startsWith(`${STATE_DIR_NAME}/`)) continue;
      const analyzer = registry.analyzerFor(f.path);
      if (analyzer === undefined) continue;
      const content = fs.readFileSync(path.join(rootDir, f.path));
      const r = analyzer.analyze({ path: f.path, content });
      diagnostics.push(...r.diagnostics);
      if (r.value === undefined) {
        failedAnalyses.push(f.path);
        continue;
      }
      analyses.push({ analysis: r.value, analyzerVersion: analyzer.version });
      texts.set(f.path, content.toString("utf8"));
    }
  } finally {
    if (options.registry === undefined) registry.dispose();
  }

  const git = await openGitProvider(rootDir);
  diagnostics.push(...git.diagnostics);
  const state = git.value === undefined ? undefined : await git.value.repositoryState();
  const commits = git.value === undefined ? undefined : await git.value.listCommits({ maxCommits: options.maxCommits ?? 500 });
  diagnostics.push(...(state?.diagnostics ?? []), ...(commits?.diagnostics ?? []));

  const indexedFiles = new Set(fingerprinted.fingerprints.map((f) => f.path).filter((p) => !p.startsWith(`${STATE_DIR_NAME}/`)));
  const moduleResolver = createTypeScriptModuleResolver({ root: rootDir, indexedFiles });
  return success({
    truth, trace, files: fingerprinted.fingerprints, analyses, failedAnalyses,
    sourceText: (p) => texts.get(p),
    moduleResolver,
    git: { ...(state?.value === undefined ? {} : { state: state.value }), ...(commits?.value === undefined ? {} : { commits: commits.value }) },
  }, diagnostics);
}
