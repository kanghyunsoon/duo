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
