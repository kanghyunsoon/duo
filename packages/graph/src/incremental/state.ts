/**
 * Incremental index state (TASK-008): .duo-project/generated/index-state.json, regenerable.
 * It holds what the next run needs to decide what to recompute: file fingerprints, analyzer and
 * resolution versions, resolution results with their dependencies, config fingerprints, the Git
 * history window and one digest per graph scope. No source text and no SourceAnalysis (those live
 * in the content-addressed analysis cache).
 *
 * The state and the graph are two stores. A token (the sha256 of the state content) is written into
 * the graph in the same transaction as the graph change, and the state file is replaced after the
 * commit. When the file and the graph disagree (a crash in between), the next run sees a token
 * mismatch and rebuilds from scratch.
 */
import { createHash } from "node:crypto";
import { createDiagnostic, DIAGNOSTIC_SEVERITY, normalizeRepoPath, STATE_DIR_NAME, type Diagnostic, type ParseResult, type RepoPath } from "@duo-director/core";
import { z } from "zod";
import { canonicalJson } from "../store/json.js";
import type { JsonObject } from "../store/types.js";
import type { FileResolution, HistorySummary } from "../build/types.js";
import { readRegenerable, writeRegenerable } from "./files.js";

export const INDEX_STATE_FILE_PATH = `${STATE_DIR_NAME}/generated/index-state.json` as RepoPath;
export const INDEX_STATE_FORMAT = "duo-index-state";
/**
 * 2 (T08.1): configs keep the diagnostics of each config file. 3 (T13): the run's persistent
 * diagnostics are kept, so readers (Review) reuse the Indexer's findings instead of recomputing them.
 */
export const INDEX_STATE_VERSION = 3;
/** Graph metadata key that holds the token of the state the graph was written with. */
export const INDEX_STATE_TOKEN_KEY = "index_state_token";
export const GRAPH_REVISION_KEY = "graph_revision";

export interface IndexedFileState {
  readonly path: RepoPath;
  readonly state: "tracked" | "untracked";
  readonly fingerprintMode: "normalized-text" | "raw";
  readonly contentHash: string;
  readonly size: number;
  readonly gitBlobOid?: string;
  /** Present for files a LanguageAnalyzer supports. */
  readonly analysis?: { readonly analyzer: string; readonly version: string; readonly status: "ok" | "failed" };
  readonly resolution?: FileResolution;
  /** Digest of the file's graph scope (File node, owned nodes, their edges). Absent for Project Truth files. */
  readonly scope?: string;
}

export interface IndexState {
  readonly format: typeof INDEX_STATE_FORMAT;
  readonly version: typeof INDEX_STATE_VERSION;
  /** sha256 of the canonical state content without the token. */
  readonly token: string;
  readonly graphSchemaVersion: number;
  readonly moduleResolutionVersion: string;
  readonly callResolutionVersion: number;
  readonly historyWindow: number;
  /** UTF-8 path order. */
  readonly files: readonly IndexedFileState[];
  /**
   * Config files the module resolver read (nearest configs and the files they extend) → contentHash,
   * and for nearest configs their diagnostics (reported again while the config is not re-read).
   */
  readonly configs: Readonly<Record<string, { readonly contentHash: string; readonly diagnostics?: readonly Diagnostic[] }>>;
  readonly truthScope: string;
  readonly history?: { readonly headOid: string; readonly shallow: boolean; readonly summary: HistorySummary };
  /** Repository state the Project node was built from (T08.1: a branch switch without a new commit is visible). */
  readonly git?: { readonly headOid?: string; readonly branch?: string; readonly detached: boolean };
  /** Persistent diagnostics of the run that wrote this state, canonical order (T13). */
  readonly diagnostics: readonly Diagnostic[];
}

const repoPath = z.string().refine((p) => normalizeRepoPath(p).value === p, "not a RepoPath");
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const storedDiagnostic = z.strictObject({
  code: z.string().refine((c) => Object.hasOwn(DIAGNOSTIC_SEVERITY, c), "unknown diagnostic code"),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  source: z.strictObject({
    path: z.string(), startLine: z.number().int().optional(), startColumn: z.number().int().optional(),
    endLine: z.number().int().optional(), endColumn: z.number().int().optional(),
  }).optional(),
});
const moduleResolution = z.union([
  z.strictObject({
    status: z.literal("resolved"), path: repoPath, claim: z.literal("typescript-resolution"),
    declarationOnly: z.boolean(), extensionSubstituted: z.boolean(), configPath: repoPath.optional(),
  }),
  z.strictObject({ status: z.literal("external"), reason: z.enum(["package", "builtin", "outside-repository"]) }),
  z.strictObject({ status: z.literal("unresolved"), reason: z.enum(["not-found", "not-indexed"]) }),
  z.strictObject({ status: z.literal("ambiguous"), candidates: z.array(repoPath) }),
  z.strictObject({ status: z.literal("unsupported"), reason: z.string() }),
]);
const storedCall = z.strictObject({
  status: z.enum(["exact", "heuristic", "ambiguous", "unresolved"]),
  reason: z.string().optional(),
  target: z.strictObject({ file: repoPath, symbol: z.string().min(1) }).optional(),
});
const fileState = z.strictObject({
  path: repoPath,
  state: z.enum(["tracked", "untracked"]),
  fingerprintMode: z.enum(["normalized-text", "raw"]),
  contentHash: hash,
  size: z.number().int().nonnegative(),
  gitBlobOid: z.string().optional(),
  analysis: z.strictObject({ analyzer: z.string().min(1), version: z.string().min(1), status: z.enum(["ok", "failed"]) }).optional(),
  resolution: z.strictObject({
    modules: z.array(moduleResolution), calls: z.array(storedCall), exportDependencies: z.array(repoPath), configFiles: z.array(repoPath),
  }).optional(),
  scope: hash.optional(),
});
const historySummary = z.strictObject({
  commitCount: z.number().int().nonnegative(),
  windowFingerprint: hash,
  coChange: z.array(z.strictObject({ a: repoPath, b: repoPath, count: z.number().int().positive() })),
  issueCommits: z.record(z.string(), z.array(z.string())),
});
const indexState = z.strictObject({
  format: z.literal(INDEX_STATE_FORMAT),
  version: z.literal(INDEX_STATE_VERSION),
  token: hash,
  graphSchemaVersion: z.number().int(),
  moduleResolutionVersion: z.string(),
  callResolutionVersion: z.number().int(),
  historyWindow: z.number().int().positive(),
  files: z.array(fileState),
  configs: z.record(z.string(), z.strictObject({ contentHash: hash, diagnostics: z.array(storedDiagnostic).optional() })),
  truthScope: hash,
  history: z.strictObject({ headOid: z.string(), shallow: z.boolean(), summary: historySummary }).optional(),
  git: z.strictObject({ headOid: z.string().optional(), branch: z.string().optional(), detached: z.boolean() }).optional(),
  diagnostics: z.array(storedDiagnostic),
});

/** Token of a state: sha256 over its canonical content without the token. */
export function indexStateToken(state: Omit<IndexState, "token">): string {
  const content: Record<string, unknown> = { ...state };
  delete content.token;
  return `sha256:${createHash("sha256").update(canonicalJson(content as unknown as JsonObject, "index-state")).digest("hex")}`;
}

export type IndexStateProblem = "no-state" | "state-invalid" | "state-unsupported";

export interface IndexStateRead {
  readonly state?: IndexState;
  readonly problem?: IndexStateProblem;
  readonly diagnostics: readonly Diagnostic[];
}

const invalid = (problem: IndexStateProblem, reason: string): IndexStateRead => ({
  problem,
  diagnostics: [createDiagnostic("INDEX_STATE_INVALID", `${INDEX_STATE_FILE_PATH} is not usable (${reason}); the graph is rebuilt`, { path: INDEX_STATE_FILE_PATH })],
});

/** Reads and verifies the state. Missing, corrupt, unsupported or tampered state is a problem, never an exception. */
export function readIndexState(root: string): IndexStateRead {
  const read = readRegenerable(root, INDEX_STATE_FILE_PATH);
  if (read.error !== undefined) return invalid("state-invalid", read.error);
  if (read.text === undefined) return { problem: "no-state", diagnostics: [] };
  let data: unknown;
  try {
    data = JSON.parse(read.text);
  } catch {
    return invalid("state-invalid", "not JSON");
  }
  const head = data as { format?: unknown; version?: unknown } | null;
  if (head?.format !== INDEX_STATE_FORMAT || head.version !== INDEX_STATE_VERSION) {
    return invalid("state-unsupported", `format ${JSON.stringify(head?.format)} version ${JSON.stringify(head?.version)}`);
  }
  const parsed = indexState.safeParse(data);
  if (!parsed.success) return invalid("state-invalid", parsed.error.issues[0]?.message ?? "schema");
  const state = parsed.data as unknown as IndexState;
  if (indexStateToken(state) !== state.token) return invalid("state-invalid", "token does not match the content");
  return { state, diagnostics: [] };
}

export function writeIndexState(root: string, state: IndexState): ParseResult<RepoPath> {
  return writeRegenerable(root, INDEX_STATE_FILE_PATH, `${JSON.stringify(state)}\n`);
}
