/**
 * Freshness decisions shared by indexRepository() (which acts on them) and inspectIndex() (which
 * only reports them). One implementation, so a status view and the Indexer never disagree on what
 * is stale (T08.1). Nothing here writes.
 */
import fs from "node:fs";
import path from "node:path";
import { computeContentHash, fingerprintModeOf, type FileFingerprint, type FingerprintChange } from "@duo-director/analyzer";
import { STATE_DIR_NAME, type Diagnostic, type RepoPath } from "@duo-director/core";
import type { FileResolution } from "../build/types.js";
import { INDEX_STATE_TOKEN_KEY, readIndexState, type IndexedFileState, type IndexState } from "./state.js";
import type { AnalysisFreshness, FileFreshness, FullRebuildReason, ModuleResolutionFreshness } from "./types.js";

export const STATE_PREFIX = `${STATE_DIR_NAME}/`;

/** What the Indexer needs to know about the graph it writes to (read-only). */
export interface IndexedGraph {
  readonly graphSchemaVersion: number;
  readMeta(key: string): string | undefined;
}

export interface PreviousState {
  readonly previous?: IndexState;
  readonly fullRebuildReason?: FullRebuildReason;
  readonly diagnostics: readonly Diagnostic[];
}

/** The stored state, when it can be trusted for this graph; else why not. */
export function loadPreviousState(root: string, graph: IndexedGraph, historyWindow: number, full: boolean): PreviousState {
  if (full) return { fullRebuildReason: "requested", diagnostics: [] };
  const read = readIndexState(root);
  if (read.state === undefined) return { fullRebuildReason: read.problem ?? "state-invalid", diagnostics: read.diagnostics };
  if (graph.readMeta(INDEX_STATE_TOKEN_KEY) !== read.state.token) return { fullRebuildReason: "state-mismatch", diagnostics: read.diagnostics };
  if (read.state.graphSchemaVersion !== graph.graphSchemaVersion || read.state.historyWindow !== historyWindow) {
    return { fullRebuildReason: "incompatible", diagnostics: read.diagnostics };
  }
  return { previous: read.state, diagnostics: read.diagnostics };
}

export const FILE_FRESHNESS = { UNCHANGED: "fresh", CHANGED: "changed", ADDED: "added", DELETED: "deleted" } as const satisfies Record<string, FileFreshness>;

/** Analysis freshness before looking at the cache: fresh = same contentHash AND same analyzer id and version. */
export function analysisFreshnessOf(
  previous: IndexState | undefined, prev: IndexedFileState | undefined, file: FileFingerprint, analyzer: { readonly id: string; readonly version: string },
): AnalysisFreshness {
  if (previous === undefined || prev?.analysis === undefined) return "missing";
  if (prev.contentHash !== file.contentHash || prev.fingerprintMode !== file.fingerprintMode) return "stale-content";
  if (prev.analysis.analyzer !== analyzer.id || prev.analysis.version !== analyzer.version) return "stale-analyzer";
  if (prev.analysis.status === "failed") return "failed";
  return "fresh";
}

/** Files whose change can change module resolution in their directory subtree (ADR-003, TASK-008). */
const RESOLUTION_CONFIG = /^(?:[tj]sconfig(?:\..+)?\.json|package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/u;

export function isResolutionConfigFile(repoPath: string): boolean {
  return RESOLUTION_CONFIG.test(repoPath.slice(repoPath.lastIndexOf("/") + 1));
}

export function hashOnDisk(root: string, repoPath: RepoPath): string | undefined {
  try {
    return computeContentHash(fs.readFileSync(path.join(root, repoPath)), fingerprintModeOf(repoPath)).contentHash;
  } catch {
    return undefined;
  }
}

export interface ResolutionSignals {
  /** A file was added or deleted among indexed files: TypeScript may pick another file. */
  readonly fileSetChanged: boolean;
  /** Directories of changed config files (their subtree resolves again). */
  readonly configDirs: readonly string[];
  /** Changed config files, including recorded config-chain files outside the index. */
  readonly changedConfigs: ReadonlySet<string>;
}

export function resolutionSignals(root: string, changes: readonly FingerprintChange[], previous: IndexState | undefined): ResolutionSignals {
  const indexed = changes.filter((c) => !c.path.startsWith(STATE_PREFIX) && c.status !== "UNCHANGED");
  const configChanges = indexed.filter((c) => isResolutionConfigFile(c.path)).map((c) => c.path);
  const changedConfigs = new Set<string>(configChanges);
  for (const [p, c] of Object.entries(previous?.configs ?? {})) if (hashOnDisk(root, p as RepoPath) !== c.contentHash) changedConfigs.add(p);
  return {
    fileSetChanged: indexed.some((c) => c.status === "ADDED" || c.status === "DELETED"),
    configDirs: configChanges.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")),
    changedConfigs,
  };
}

const under = (file: string, dir: string) => dir === "" || file.startsWith(`${dir}/`);

export function moduleFreshnessOf(
  file: RepoPath, prev: FileResolution | undefined, previous: IndexState | undefined, resolverVersion: string,
  changedFiles: ReadonlySet<string>, signals: ResolutionSignals,
): ModuleResolutionFreshness {
  if (previous === undefined || prev === undefined) return "missing";
  if (previous.moduleResolutionVersion !== resolverVersion) return "stale-version";
  if (changedFiles.has(file)) return "stale-source";
  if (signals.fileSetChanged) return "stale-file-set";
  if (signals.configDirs.some((d) => under(file, d)) || prev.configFiles.some((c) => signals.changedConfigs.has(c))) return "stale-config";
  return "fresh";
}

