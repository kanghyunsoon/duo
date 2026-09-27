/**
 * Test support for the Context Compiler (not part of the build): a Git repository copied from
 * fixtures/context/app with a co-change history, indexed with the real Indexer.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { loadProjectTruth, type ProjectTruth } from "@duo-director/core";
import { dumpGraph, indexRepository, openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { compileContext, type CompileContextOptions } from "./compile.js";
import type { ContextRequest, ContextResult } from "./types.js";

export const CONTEXT_FIXTURE = fileURLToPath(new URL("../../../../fixtures/context/app/", import.meta.url));
export const GAP_FIXTURE = fileURLToPath(new URL("../../../../fixtures/gap/app/", import.meta.url));
export const REVIEW_FIXTURE = fileURLToPath(new URL("../../../../fixtures/review/app/", import.meta.url));
export const INIT_FIXTURE = fileURLToPath(new URL("../../../../fixtures/init/app/", import.meta.url));
export const INIT_GOLDEN = fileURLToPath(new URL("../../../../fixtures/init/expected/", import.meta.url));
export const HISTORY = 20;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "DUO Test", GIT_AUTHOR_EMAIL: "test@duo.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "DUO Test", GIT_COMMITTER_EMAIL: "test@duo.invalid", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export interface ContextRepo {
  readonly root: string;
  git(...args: string[]): string;
  read(file: string): string;
  write(file: string, text: string): void;
  edit(file: string, from: string, to: string): void;
  index(): Promise<void>;
  compile(request: ContextRequest, options?: Omit<CompileContextOptions, "graph" | "registry">): Promise<ContextResult>;
  graphDump(): ReturnType<typeof dumpGraph>;
  truth(): ProjectTruth;
  meta(key: string): string | undefined;
}

export async function contextRegistry(): Promise<AnalyzerRegistry> {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  return created.value;
}

function withGraph<T>(root: string, fn: (store: GraphStore) => T): T {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    return fn(opened.value);
  } finally {
    opened.value.close();
  }
}

/** The fixture as a Git repository; AuthService.ts and util/config.ts change together in three commits (CHANGED_WITH). Not indexed yet. */
export function makeContextRepo(temps: string[], registry: AnalyzerRegistry, fixture: string = CONTEXT_FIXTURE): ContextRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-context-")));
  temps.push(root);
  fs.cpSync(fixture, root, { recursive: true });
  const abs = (f: string) => path.join(root, f);
  const repo: ContextRepo = {
    root,
    git: (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }),
    read: (f) => fs.readFileSync(abs(f), "utf8"),
    write: (f, text) => {
      fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
      fs.writeFileSync(abs(f), text);
    },
    edit: (f, from, to) => {
      const text = repo.read(f);
      if (!text.includes(from)) throw new Error(`${f} does not contain ${JSON.stringify(from)}`);
      repo.write(f, text.replace(from, to));
    },
    index: async () => {
      const opened = openProjectGraphStore(root);
      if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
      try {
        const r = await indexRepository(root, { store: opened.value, registry, historyWindow: HISTORY });
        if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
      } finally {
        opened.value.close();
      }
    },
    compile: async (request, options = {}) => {
      const opened = openProjectGraphStore(root);
      if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
      try {
        const r = await compileContext(root, request, { ...options, graph: opened.value, registry, historyWindow: HISTORY });
        if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
        return r.value;
      } finally {
        opened.value.close();
      }
    },
    graphDump: () => withGraph(root, (s) => dumpGraph(s)),
    truth: () => {
      const loaded = loadProjectTruth(root);
      if (loaded.value === undefined) throw new Error(JSON.stringify(loaded.diagnostics));
      return loaded.value.truth;
    },
    meta: (key) => withGraph(root, (s) => s.readMeta(key)),
  };
  repo.git("-c", "init.defaultBranch=main", "init", "-q");
  repo.git("config", "core.autocrlf", "false");
  repo.git("config", "commit.gpgsign", "false");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "init");
  if (fixture !== CONTEXT_FIXTURE) return repo;
  for (const n of [1, 2, 3]) {
    fs.appendFileSync(abs("src/auth/AuthService.ts"), `// revision ${n}\n`);
    fs.appendFileSync(abs("src/util/config.ts"), `// revision ${n}\n`);
    repo.git("commit", "-q", "-am", `GAME-42 tune ${n}`);
  }
  return repo;
}
