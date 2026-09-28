/** Helpers shared by the CLI commands (T15): environment, analyzer registry, graph access, actor. */
import { createDefaultAnalyzerRegistry, readGitUserName, type AnalyzerRegistry } from "@duo-director/analyzer";
import { createDiagnostic, loadProjectTruth, type DecisionActor, type Diagnostic, type LoadedProject, type ParseResult } from "@duo-director/core";
import { openProjectGraphReader, openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import type { Io } from "../io.js";
import { t, type Locale } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";

export interface Env {
  readonly root: string;
  readonly json: boolean;
  readonly locale: Locale;
  readonly nonInteractive: boolean;
  readonly yes: boolean;
  readonly verbose: boolean;
  readonly io: Io;
}

/** Prompts are allowed: a terminal, not --non-interactive, not --json. */
export const interactive = (env: Env) => env.io.isTTY && !env.nonInteractive && !env.json;

/** Progress lines for humans (never on stdout in --json mode). */
export const progress = (env: Env, line: string) => { if (!env.json) env.io.out(line); };

export async function withRegistry<T>(fn: (registry: AnalyzerRegistry) => Promise<T>): Promise<T> {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new CliFailure(created.diagnostics);
  try {
    return await fn(created.value);
  } finally {
    created.value.dispose();
  }
}

export class CliFailure extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));
  }
}

/** Opens the graph for reading only (creates nothing). */
export async function withReader<T>(root: string, fn: (graph: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphReader(root);
  if (opened.value === undefined) throw new CliFailure(opened.diagnostics);
  try {
    return await fn(opened.value);
  } finally {
    opened.value.close();
  }
}

export async function withWriter<T>(root: string, fn: (graph: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new CliFailure(opened.diagnostics);
  try {
    return await fn(opened.value);
  } finally {
    opened.value.close();
  }
}

/** The human at this terminal, named by Git user.name. Local-first: a display name, not an authentication. */
export async function humanActor(root: string): Promise<DecisionActor> {
  return { kind: "human", name: (await readGitUserName(root)) ?? "human" };
}

/** Loads Project Truth, or the NOT_INITIALIZED outcome. */
export function requireProject(env: Env, command: string): ParseResult<LoadedProject> & { readonly outcome?: Outcome } {
  const loaded = loadProjectTruth(env.root);
  if (loaded.value !== undefined) return loaded;
  const missing = loaded.diagnostics.some((d) => d.code === "PROJECT_FILE_MISSING");
  return {
    diagnostics: loaded.diagnostics,
    outcome: failed(command, missing ? EXIT.NOT_INITIALIZED : EXIT.ERROR, loaded.diagnostics, [missing ? t(env.locale, "not-initialized") : loaded.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")]),
  };
}

export const usage = (command: string, message: string): Outcome =>
  failed(command, EXIT.ERROR, [createDiagnostic("CLI_USAGE_INVALID", message)], [message]);

export function diagLines(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
}
