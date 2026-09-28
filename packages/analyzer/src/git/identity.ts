/**
 * The local Git identity (T15): user.name as configured for the repository. A display name recorded
 * by human surfaces (Decision confirm, Review Record, Adoption Baseline). Local-first: it is not an
 * authentication; anyone can set it (docs/10-security.md).
 */
import path from "node:path";
import { runGit } from "./exec.js";

/** Git user.name for root, or undefined when it is not set (or Git is unavailable). Read-only. */
export async function readGitUserName(root: string): Promise<string | undefined> {
  const r = await runGit(path.resolve(root), ["config", "--get", "user.name"]);
  if (!r.ok) return undefined;
  const name = r.value.trim();
  return name === "" ? undefined : name;
}

/**
 * The top level of the Git work tree that contains dir (T17: duoctl mcp --root-from git-cwd), or
 * undefined when dir is not inside a work tree. Read-only; the caller still validates the result as a
 * repository root.
 */
export async function findGitTopLevel(dir: string): Promise<string | undefined> {
  const r = await runGit(path.resolve(dir), ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return undefined;
  const top = r.value.replace(/\r?\n$/u, "");
  return top === "" ? undefined : path.resolve(top);
}
