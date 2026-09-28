/**
 * Test helpers for the incremental Indexer (TASK-008): a Git repository from the graph fixture, an
 * analyzer registry that counts parses, the clean full rebuild oracle and graph queries.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAnalyzerRegistry, createDefaultAnalyzerRegistry, readFingerprintFile, type AnalyzerRegistry, type LanguageAnalyzer } from "@duo-director/analyzer";
import { persistentDiagnostics, type Diagnostic, type EntityRef, type RepoPath } from "@duo-director/core";
import { applyGraphPlan } from "../build/apply.js";
import { buildGraphPlan } from "../build/builder.js";
import { collectGraphFacts } from "../build/collect.js";
import { checkGraph, dumpGraph } from "../check.js";
import { openNodeSqliteGraphStore } from "../store/node-sqlite/node-sqlite-graph-store.js";
import type { GraphReader, GraphStore } from "../store/types.js";

export const FIXTURE = decodeURIComponent(new URL("../../../../fixtures/graph/app/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "DUO Test", GIT_AUTHOR_EMAIL: "test@duo.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "DUO Test", GIT_COMMITTER_EMAIL: "test@duo.invalid", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export interface TestRepo {
  readonly root: string;
  git(...args: string[]): string;
  write(file: string, text: string): void;
  read(file: string): string;
  edit(file: string, from: string, to: string): void;
  remove(file: string): void;
  rename(from: string, to: string): void;
}

export function makeRepo(temps: string[], files?: Record<string, string>): TestRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-incr-")));
  temps.push(root);
  if (files === undefined) fs.cpSync(FIXTURE, root, { recursive: true });
  const abs = (f: string) => path.join(root, f);
  const repo: TestRepo = {
    root,
    git: (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }),
    write: (f, text) => {
      fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
      fs.writeFileSync(abs(f), text);
    },
    read: (f) => fs.readFileSync(abs(f), "utf8"),
    edit: (f, from, to) => {
      const text = repo.read(f);
      if (!text.includes(from)) throw new Error(`${f} does not contain ${JSON.stringify(from)}`);
      repo.write(f, text.replace(from, to));
    },
    remove: (f) => fs.rmSync(abs(f)),
    rename: (from, to) => fs.renameSync(abs(from), abs(to)),
  };
  for (const [f, text] of Object.entries(files ?? {})) repo.write(f, text);
  repo.git("-c", "init.defaultBranch=main", "init", "-q");
  repo.git("config", "core.autocrlf", "false");
  repo.git("config", "commit.gpgsign", "false");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "init APP-10");
  return repo;
}

/** A registry that counts LanguageAnalyzer.analyze() calls (AST parses). */
export interface CountingRegistry {
  readonly registry: AnalyzerRegistry;
  parses: number;
}

export function countingRegistry(base: AnalyzerRegistry, version?: string): CountingRegistry {
  const out: CountingRegistry = { registry: undefined as unknown as AnalyzerRegistry, parses: 0 };
  const analyzers: LanguageAnalyzer[] = base.analyzers.map((a) => ({
    id: a.id,
    version: version ?? a.version,
    languages: a.languages,
    extensions: a.extensions,
    ...(a.contextualExtensions === undefined ? {} : { contextualExtensions: a.contextualExtensions }),
    capabilities: a.capabilities,
    callResolution: a.callResolution,
    // A different version is a different analyzer identity (its files are analyzed again).
    identity: version === undefined || version === a.version ? a.identity : `${a.identity}+version=${version}`,
    supports: (p) => a.supports(p),
    analyze: (input) => {
      out.parses++;
      return a.analyze(input);
    },
    dispose: () => {},
  }));
  (out as { registry: AnalyzerRegistry }).registry = createAnalyzerRegistry(analyzers);
  return out;
}

export async function baseRegistry(): Promise<AnalyzerRegistry> {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  return created.value;
}

export function memoryStore(): GraphStore {
  const opened = openNodeSqliteGraphStore({ path: ":memory:" });
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  return opened.value;
}

/** The oracle: a clean full rebuild (T07 collect + build + apply) into a fresh database: canonical rows and persistent diagnostics. */
export async function cleanRebuildWithDiagnostics(root: string, registry: AnalyzerRegistry, historyWindow: number): Promise<{ graph: ReturnType<typeof dumpGraph>; diagnostics: Diagnostic[] }> {
  const facts = await collectGraphFacts(root, { registry, maxCommits: historyWindow });
  if (facts.value === undefined) throw new Error(JSON.stringify(facts.diagnostics));
  const plan = buildGraphPlan(facts.value);
  const store = memoryStore();
  try {
    const applied = applyGraphPlan(store, plan);
    if (applied.value === undefined) throw new Error(JSON.stringify(applied.diagnostics));
    return { graph: dumpGraph(store), diagnostics: persistentDiagnostics([...facts.diagnostics, ...plan.diagnostics]) };
  } finally {
    store.close();
  }
}

export async function cleanRebuild(root: string, registry: AnalyzerRegistry, historyWindow: number): Promise<ReturnType<typeof dumpGraph>> {
  return (await cleanRebuildWithDiagnostics(root, registry, historyWindow)).graph;
}

export function invariantProblems(store: GraphReader, root: string): string[] {
  return checkGraph(store, { fingerprints: readFingerprintFile(root).value ?? [] }).map((d) => d.message);
}

export function edge(store: GraphReader, from: string, type: string, to: string) {
  return store.adjacentEdges([parse(from)], { direction: "outgoing", types: [type as never], limit: 10_000 }).edges.find((e) => e.to === to);
}

export function nodeExists(store: GraphReader, id: string): boolean {
  return store.getNode(parse(id)) !== undefined;
}

export function edgeCount(store: GraphReader, type: string): number {
  return dumpGraph(store).edges.filter((e) => e.includes(`"type":"${type}"`)).length;
}

function parse(id: string): EntityRef {
  const colon = id.indexOf(":");
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  const hash = rest.indexOf("#");
  switch (kind) {
    case "file": return { type: "file", path: rest as RepoPath };
    case "sym": return { type: "symbol", path: rest.slice(0, hash) as RepoPath, symbol: rest.slice(hash + 1) };
    case "test": return { type: "test", path: rest.slice(0, hash) as RepoPath, name: rest.slice(hash + 1) };
    case "req": return { type: "requirement", id: rest } as EntityRef;
    case "dec": return { type: "decision", id: rest } as EntityRef;
    case "issue": return { type: "issue", id: rest } as EntityRef;
    default: throw new Error(id);
  }
}

