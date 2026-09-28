/**
 * Repository observation (TASK-014, REQ-INIT-001). Deterministic facts read with ordinary code, no
 * LLM: repository name, Git state, languages by extension, manifests, packages and workspaces, known
 * scripts, technical metadata, source and test roots. Input is the Scanner's file list, so .gitignore,
 * DUO's own regenerable data and secret files (.env, keys, credentials) are already excluded; only
 * manifests are read. Script command text is not copied (it can hold tokens): names and how to run them.
 * Observations are never Product Intent: "engines.node >=24" is technical metadata, not a Constraint.
 */
import fs from "node:fs";
import path from "node:path";
import { JAVASCRIPT_EXTENSIONS, TYPESCRIPT_EXTENSIONS, type GitRepositoryState, type RepositoryScan } from "@duo-director/analyzer";
import { compareUtf8, parseYaml, readSourceFile, STATE_DIR_NAME, type RepoPath } from "@duo-director/core";
import { nonApplicationReason } from "../review/scope.js";
import type { WorkingTreeObservation } from "../adoption/types.js";
import type { RepositoryObservation } from "./types.js";

const LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".rb": "ruby", ".php": "php",
  ".cs": "csharp", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".swift": "swift", ".scala": "scala",
  ".dart": "dart", ".lua": "lua", ".sh": "shell",
};
const ANALYZED = new Set<string>([...Object.keys(TYPESCRIPT_EXTENSIONS), ...Object.keys(JAVASCRIPT_EXTENSIONS)].map((e) => `.${e}`));

const MANIFESTS: Readonly<Record<string, string>> = {
  "package.json": "npm", "pnpm-workspace.yaml": "pnpm-workspace", "pnpm-lock.yaml": "lockfile", "package-lock.json": "lockfile", "yarn.lock": "lockfile",
  "bun.lockb": "lockfile", "tsconfig.json": "tsconfig", "deno.json": "deno", "deno.jsonc": "deno", "Cargo.toml": "cargo", "go.mod": "go",
  "pyproject.toml": "python", "setup.py": "python", "requirements.txt": "python", "pom.xml": "maven", "build.gradle": "gradle",
  "build.gradle.kts": "gradle", "settings.gradle": "gradle", "Gemfile": "bundler", "composer.json": "composer",
};
const MANIFEST_MAX_DEPTH = 4;
const LIST_CAP = 50;
const SCRIPT_NAME = /^(?:build|test|lint|typecheck|check|verify|format|e2e)(?::[\w-]+)?$/u;
const SOURCE_DIRS = new Set(["src", "lib", "app", "source", "sources"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const MAX_MANIFEST_BYTES = 1024 * 1024;

export const extensionOf = (p: string): string => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function readJson(root: string, file: RepoPath): Record<string, unknown> | undefined {
  try {
    if (fs.statSync(path.join(root, file)).size > MAX_MANIFEST_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const text = readSourceFile(root, file).value;
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function count(items: readonly string[]): { path: string; files: number }[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m].map(([p, files]) => ({ path: p, files })).sort((a, b) => compareUtf8(a.path, b.path)).slice(0, LIST_CAP);
}

/** The directory a source file belongs to: up to its src/lib/app segment, else its top-level directory, else ".". */
function sourceRootOf(p: string): string {
  const segs = p.split("/");
  const i = segs.slice(0, -1).findIndex((s) => SOURCE_DIRS.has(s.toLowerCase()));
  if (i >= 0) return segs.slice(0, i + 1).join("/");
  return segs.length > 1 ? (segs[0] ?? ".") : ".";
}

function testRootOf(p: string): string | undefined {
  const segs = p.split("/");
  const i = segs.slice(0, -1).findIndex((s) => TEST_DIRS.has(s.toLowerCase()));
  return i >= 0 ? segs.slice(0, i + 1).join("/") : undefined;
}

export function observeRepository(root: string, scan: RepositoryScan, git: GitRepositoryState, workingTree: WorkingTreeObservation): RepositoryObservation {
  const files = scan.files.map((f) => f.path).filter((p) => !p.startsWith(`${STATE_DIR_NAME}/`));
  const excluded: Record<string, number> = {};
  for (const e of scan.excluded) excluded[e.reason] = (excluded[e.reason] ?? 0) + 1;

  const langCounts = new Map<string, { files: number; analyzed: boolean }>();
  const sources: string[] = [];
  const tests: string[] = [];
  let colocatedTests = 0;
  for (const p of files) {
    const ext = extensionOf(p);
    const language = LANGUAGES[ext];
    if (language === undefined) continue;
    const entry = langCounts.get(language) ?? { files: 0, analyzed: false };
    langCounts.set(language, { files: entry.files + 1, analyzed: entry.analyzed || ANALYZED.has(ext) });
    const reason = nonApplicationReason(p);
    if (reason === "test") {
      const r = testRootOf(p);
      if (r === undefined) colocatedTests++;
      else tests.push(r);
    } else if (reason === undefined) {
      sources.push(sourceRootOf(p));
    }
  }
  const languages = [...langCounts].map(([language, v]) => ({ language, files: v.files, analyzed: v.analyzed }))
    .sort((a, b) => b.files - a.files || compareUtf8(a.language, b.language));

  const manifests = files.flatMap((p) => {
    const kind = MANIFESTS[baseName(p)] ?? (/\.(?:csproj|sln)$/u.test(p) ? "dotnet" : undefined);
    return kind !== undefined && p.split("/").length <= MANIFEST_MAX_DEPTH ? [{ path: p, kind }] : [];
  }).slice(0, LIST_CAP * 2);

  const npm = manifests.filter((m) => m.kind === "npm").slice(0, LIST_CAP);
  const pkgs = new Map(npm.map((m) => [m.path, readJson(root, m.path)] as const));
  const rootPkg = pkgs.get("package.json" as RepoPath);
  const packages = npm.map((m) => {
    const name = str(pkgs.get(m.path)?.name);
    return { manifest: m.path, ...(name === undefined ? {} : { name }) };
  });

  const workspaces: { manifest: RepoPath; patterns: string[] }[] = [];
  if (rootPkg !== undefined) {
    const ws = rootPkg.workspaces;
    const patterns = Array.isArray(ws) ? strings(ws) : strings((ws as { packages?: unknown } | undefined)?.packages);
    if (patterns.length > 0) workspaces.push({ manifest: "package.json" as RepoPath, patterns });
  }
  if (files.includes("pnpm-workspace.yaml" as RepoPath)) {
    const text = readSourceFile(root, "pnpm-workspace.yaml").value;
    const data = text === undefined ? undefined : parseYaml({ path: "pnpm-workspace.yaml", text }).value?.data;
    const patterns = strings((data as { packages?: unknown } | undefined)?.packages);
    if (patterns.length > 0) workspaces.push({ manifest: "pnpm-workspace.yaml" as RepoPath, patterns });
  }

  const declaredPm = str(rootPkg?.packageManager);
  const lock = (n: string) => files.includes(n as RepoPath);
  const pmName = declaredPm?.split("@")[0] ?? (lock("pnpm-lock.yaml") ? "pnpm" : lock("yarn.lock") ? "yarn" : lock("bun.lockb") ? "bun" : rootPkg !== undefined ? "npm" : undefined);
  const packageManager = pmName === undefined ? undefined : {
    value: pmName,
    source: declaredPm !== undefined ? { path: "package.json" as RepoPath, field: "packageManager", kind: "manifest" as const } : { kind: "scan" as const },
  };
  const scripts = Object.keys((rootPkg?.scripts as Record<string, unknown> | undefined) ?? {})
    .filter((n) => SCRIPT_NAME.test(n)).sort(compareUtf8)
    .map((name) => ({ manifest: "package.json" as RepoPath, name, run: `${pmName ?? "npm"} run ${name}` }));
  const technical: { manifest: RepoPath; field: string; value: string }[] = [];
  const engines = rootPkg?.engines;
  if (typeof engines === "object" && engines !== null) {
    for (const [k, v] of Object.entries(engines).sort(([a], [b]) => compareUtf8(a, b))) {
      if (typeof v === "string") technical.push({ manifest: "package.json" as RepoPath, field: `engines.${k}`, value: v });
    }
  }
  if (declaredPm !== undefined) technical.push({ manifest: "package.json" as RepoPath, field: "packageManager", value: declaredPm });

  const pkgName = str(rootPkg?.name);
  const pkgDescription = str(rootPkg?.description);
  const name = pkgName !== undefined
    ? { value: pkgName, source: { path: "package.json" as RepoPath, field: "name", kind: "manifest" as const } }
    : { value: path.basename(path.resolve(root)), source: { kind: "directory" as const } };

  return {
    provenance: "observed", name,
    ...(pkgDescription === undefined ? {} : { description: { value: pkgDescription, source: { path: "package.json" as RepoPath, field: "description", kind: "manifest" as const } } }),
    git: {
      ...(git.branch === undefined ? {} : { branch: git.branch }), ...(git.headOid === undefined ? {} : { headOid: git.headOid }),
      detached: git.detached, unborn: git.unborn, shallow: git.shallow,
    },
    files: { indexable: files.length, excluded: Object.fromEntries(Object.entries(excluded).sort(([a], [b]) => compareUtf8(a, b))) },
    languages, manifests, packages, workspaces, ...(packageManager === undefined ? {} : { packageManager }), scripts, technical,
    sourceRoots: count(sources), testRoots: count(tests), colocatedTests,
    workingTree: { workingTreeDirty: workingTree.dirty, ...workingTree },
  };
}

