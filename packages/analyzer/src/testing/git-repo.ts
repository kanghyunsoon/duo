/**
 * Test support: throwaway Git repositories and platform capability probes. Not part of the build
 * (excluded in packages/analyzer/tsconfig.json).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REDIRECTING_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of REDIRECTING_ENV) delete env[key];
  return env;
}

export interface TempRepo {
  readonly root: string;
  write(file: string, content: string | Uint8Array): string;
  git(...args: string[]): string;
  add(...files: string[]): void;
  /** Adds an index entry for a symlink without creating one on disk (works on every OS). */
  addSymlinkEntry(file: string, target: string): void;
}

const temps: string[] = [];

export function makeTempDir(prefix = "duo-scan-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  while (temps.length > 0) fs.rmSync(temps.pop() ?? "", { recursive: true, force: true });
}

export function createTempRepo(): TempRepo {
  const root = makeTempDir();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: gitEnv(), encoding: "utf8", windowsHide: true });
  const gitInput = (input: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: gitEnv(), encoding: "utf8", input, windowsHide: true });
  git("init", "-q");
  // Store content exactly as written, whatever the host defaults are.
  git("config", "core.autocrlf", "false");
  git("config", "core.safecrlf", "false");
  return {
    root,
    git,
    write(file, content) {
      const absolute = path.join(root, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return absolute;
    },
    add(...files) {
      git("add", "--", ...files);
    },
    addSymlinkEntry(file, target) {
      const oid = gitInput(target, "hash-object", "-w", "--stdin").trim();
      git("update-index", "--add", "--cacheinfo", `120000,${oid},${file}`);
    },
  };
}

/** True when this process can create symlinks (Windows needs Developer Mode or elevation). */
export function canCreateSymlinks(): boolean {
  const dir = makeTempDir("duo-symlink-probe-");
  try {
    fs.writeFileSync(path.join(dir, "target"), "x");
    fs.symlinkSync("target", path.join(dir, "link"), "file");
    return fs.lstatSync(path.join(dir, "link")).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when "a" and "A" name the same file in the temp directory (default Windows and macOS volumes). */
export function isCaseInsensitiveFileSystem(): boolean {
  const dir = makeTempDir("duo-case-probe-");
  fs.writeFileSync(path.join(dir, "probe"), "x");
  return fs.existsSync(path.join(dir, "PROBE"));
}

/** True when two names that differ only in Unicode normalization can coexist in one directory. */
export function keepsDistinctUnicodeNames(): boolean {
  const dir = makeTempDir("duo-nfd-probe-");
  fs.writeFileSync(path.join(dir, "caf\u00E9"), "1");
  fs.writeFileSync(path.join(dir, "cafe\u0301"), "2");
  return fs.readdirSync(dir).length === 2;
}
