/**
 * Running Git (T04, T06). Internal to the analyzer package: callers get parsed domain values, never
 * Git output. Git is spawned as an executable with an argument array (no shell), so paths and
 * revisions cannot inject shell syntax. The environment is fixed so that locale, pager, prompts and
 * user diff settings do not change the output; the user's Git config files are never modified.
 */
import { execFile } from "node:child_process";

export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly gitMissing?: boolean };

/** Variables that would point Git at another repository or index than the root, or change diff output. */
const REMOVED_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE",
  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_TRACE", "LANGUAGE",
];

/** Config forced for every call (command-line -c, not written anywhere). */
const FORCED_CONFIG = [
  "core.quotePath=false", "core.pager=cat", "color.ui=false",
  "diff.noprefix=false", "diff.mnemonicPrefix=false", "diff.relative=false", "diff.external=",
  "diff.suppressBlankEmpty=false", "log.showSignature=false",
];

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, LC_ALL: "C", LANG: "C", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of REMOVED_ENV) delete env[key];
  return env;
}

export interface RunGitOptions {
  /** Written to stdin (for --batch commands). */
  readonly input?: string;
}

/** Runs git in root and returns raw stdout bytes. */
export function runGitBytes(root: string, args: readonly string[], options: RunGitOptions = {}): Promise<GitResult<Buffer>> {
  const configArgs = FORCED_CONFIG.flatMap((c) => ["-c", c]);
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["--no-pager", ...configArgs, ...args],
      { cwd: root, env: gitEnvironment(), encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, value: stdout });
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, message: "git executable not found", gitMissing: true });
          return;
        }
        const detail = stderr.toString("utf8").trim();
        resolve({ ok: false, message: detail === "" ? error.message : detail });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs git in root and decodes stdout as UTF-8. */
export async function runGit(root: string, args: readonly string[], options: RunGitOptions = {}): Promise<GitResult<string>> {
  const r = await runGitBytes(root, args, options);
  return r.ok ? { ok: true, value: r.value.toString("utf8") } : r;
}
