/**
 * One adapter per agent (TASK-017). The installer core knows only this contract; configuration
 * formats, file locations and how the agent spawns a server stay inside the adapter.
 */
import path from "node:path";
import type { AgentId, DuoLauncher, McpInspection, McpLaunchEntry } from "./types.js";

export const SERVER_NAME = "duo-director";

export interface LaunchEnvironment {
  /** The working directory the agent starts the server in (a session in the repository root). */
  readonly cwd: string;
  /** Variables the agent adds to the server environment. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentIntegrationAdapter {
  readonly id: AgentId;
  /** Repository-relative configuration file (project scope). */
  readonly mcpTarget: string;
  /** Repository-relative bridge file. */
  readonly bridgeTarget: string;
  readonly projectTrustRequired: boolean;
  readonly approvalRequired: boolean;
  /** The entry DUO writes for this launcher (portable: no absolute repository path). */
  plannedEntry(launcher: DuoLauncher): McpLaunchEntry & Readonly<Record<string, unknown>>;
  /** Read-only look at the configuration text (undefined: the file does not exist). */
  inspect(text: string | undefined, planned: McpLaunchEntry): McpInspection;
  /** The configuration with the planned entry; only called when inspect allows a write. Undefined when it cannot be merged. */
  write(text: string | undefined, planned: McpLaunchEntry): string | undefined;
  /** The configuration without the DUO entry: null means the file held only DUO content (delete it); undefined means nothing DUO-managed to remove. */
  remove(text: string): string | null | undefined;
  /** The configured duo-director launch, for verification. */
  readEntry(text: string): McpLaunchEntry | undefined;
  launchEnvironment(root: string): LaunchEnvironment;
}

/** A stdio entry that starts DUO's MCP server (duoctl directly or through a launcher such as npx). */
export function isDuoLaunch(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as { command?: unknown; args?: unknown };
  if (typeof e.command !== "string" || !Array.isArray(e.args)) return false;
  const args = e.args.filter((a): a is string => typeof a === "string");
  const base = path.basename(e.command.replaceAll("\\", "/")).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/u, "");
  return args.includes("mcp") && (base === "duoctl" || args.includes("duoctl"));
}

export const sameLaunch = (a: McpLaunchEntry, b: McpLaunchEntry): boolean =>
  a.command === b.command && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
