/**
 * Shared operations (TASK-016, C135): one function per DUO operation, used by every surface (CLI
 * --json result and MCP structuredContent). Each returns a versioned semantic payload built from the
 * domain result; surface metadata (timings, a CLI-only record) stays outside it. Graph access is per
 * call: a store is opened, used and closed before the function returns, so a long-lived process never
 * pins an old SQLite snapshot or holds a transaction.
 */
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { loadProjectTruth, type Diagnostic, type LoadedProject } from "@duo-director/core";
import type { TokenCountMemo } from "@duo-director/director";
import { openProjectGraphReader, openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { LLMProviderPool } from "../llm/factory.js";

export type Failure = { readonly kind: "not-initialized" | "failed"; readonly diagnostics: readonly Diagnostic[] };

export type Operation<T> = { readonly kind: "ok"; readonly payload: T; readonly performance?: unknown; readonly diagnostics: readonly Diagnostic[] } | Failure;

export interface OperationOptions {
  /** Reused when given (the caller disposes it); otherwise one is created and disposed per call. */
  readonly registry?: AnalyzerRegistry;
  readonly signal?: AbortSignal;
  /**
   * LLM providers by project configuration (T12B). Default: a pool over this process's environment,
   * made per call (CLI). The MCP server passes one pool for its lifetime (environment snapshot at startup).
   */
  readonly llm?: LLMProviderPool;
  /**
   * Repository token counts kept by a long-lived surface (MCP server, UI server) across calls
   * (TASK-019). In memory only; the context and review results are the same without it.
   */
  readonly tokenCounts?: TokenCountMemo;
}

/** The pool of the options, or one over the current environment. */
export const llmPoolOf = (options: OperationOptions): LLMProviderPool => options.llm ?? new LLMProviderPool(process.env);

export const NOT_INITIALIZED_FORMAT = "duo.not-initialized/1";

export class OperationFailure extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));
  }
}

export async function withRegistry<T>(given: AnalyzerRegistry | undefined, fn: (registry: AnalyzerRegistry) => Promise<T>): Promise<T> {
  if (given !== undefined) return fn(given);
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new OperationFailure(created.diagnostics);
  try {
    return await fn(created.value);
  } finally {
    created.value.dispose();
  }
}

/** Read-only graph for one call (creates nothing when there is no graph.db). */
export async function withGraphReader<T>(root: string, fn: (graph: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphReader(root);
  if (opened.value === undefined) throw new OperationFailure(opened.diagnostics);
  try {
    return await fn(opened.value);
  } finally {
    opened.value.close();
  }
}

export async function withGraphWriter<T>(root: string, fn: (graph: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new OperationFailure(opened.diagnostics);
  try {
    return await fn(opened.value);
  } finally {
    opened.value.close();
  }
}

/** Project Truth, or the not-initialized / failed outcome. */
export function project(root: string): { readonly value?: LoadedProject; readonly outcome?: Failure } {
  const loaded = loadProjectTruth(root);
  if (loaded.value !== undefined) return { value: loaded.value };
  const missing = loaded.diagnostics.some((d) => d.code === "PROJECT_FILE_MISSING");
  return { outcome: missing ? { kind: "not-initialized", diagnostics: loaded.diagnostics } : { kind: "failed", diagnostics: loaded.diagnostics } };
}

/** Runs an operation body; an OperationFailure becomes a failed outcome. */
export async function guarded<T>(fn: () => Promise<Operation<T>>): Promise<Operation<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OperationFailure) return { kind: "failed", diagnostics: error.diagnostics };
    throw error;
  }
}

export const errorsOf = (d: readonly Diagnostic[]) => d.filter((x) => x.severity === "error");
