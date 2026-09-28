/**
 * Where duoctl mcp gets its repository root (T17). Explicit in every case; the result is then validated
 * as the top level of a Git work tree by serveDuoMcp.
 *   --root <path>                    the given path
 *   --root-from git-cwd              the top level of the Git work tree containing the working directory
 *                                    (Codex spawns project servers in the session directory, which can be
 *                                    a subdirectory; a relative cwd in .codex/config.toml is not stable)
 *   --root-from env:<NAME>           an absolute path in the server's environment variable NAME
 *                                    (Claude Code sets CLAUDE_PROJECT_DIR for stdio servers)
 * No other forms, no shell interpolation, no upward search for .duo-project.
 */
import path from "node:path";
import { findGitTopLevel } from "@duo-director/analyzer";
import { createDiagnostic, failure, success, type ParseResult } from "@duo-director/core";

export const ROOT_FROM_GIT_CWD = "git-cwd";
export const ROOT_FROM_ENV_PREFIX = "env:";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function isRootFrom(value: string): boolean {
  return value === ROOT_FROM_GIT_CWD || (value.startsWith(ROOT_FROM_ENV_PREFIX) && ENV_NAME.test(value.slice(ROOT_FROM_ENV_PREFIX.length)));
}

export async function resolveMcpRoot(
  spec: { readonly root?: string; readonly rootFrom?: string },
  host: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
): Promise<ParseResult<string>> {
  if (spec.root !== undefined && spec.rootFrom !== undefined) return failure([createDiagnostic("CLI_USAGE_INVALID", "--root and --root-from cannot be combined")]);
  if (spec.rootFrom === undefined) return success(path.resolve(host.cwd, spec.root ?? "."));
  if (!isRootFrom(spec.rootFrom)) return failure([createDiagnostic("CLI_USAGE_INVALID", `--root-from must be ${ROOT_FROM_GIT_CWD} or ${ROOT_FROM_ENV_PREFIX}<NAME>`)]);
  if (spec.rootFrom === ROOT_FROM_GIT_CWD) {
    const top = await findGitTopLevel(host.cwd);
    return top === undefined
      ? failure([createDiagnostic("MCP_ROOT_UNRESOLVED", `"${host.cwd}" is not inside a Git work tree (--root-from ${ROOT_FROM_GIT_CWD})`)])
      : success(top);
  }
  const name = spec.rootFrom.slice(ROOT_FROM_ENV_PREFIX.length);
  const value = host.env[name];
  if (value === undefined || value === "") return failure([createDiagnostic("MCP_ROOT_UNRESOLVED", `environment variable ${name} is not set (--root-from ${spec.rootFrom})`)]);
  if (!path.isAbsolute(value)) return failure([createDiagnostic("MCP_ROOT_UNRESOLVED", `environment variable ${name} is not an absolute path (--root-from ${spec.rootFrom})`)]);
  return success(path.resolve(value));
}
