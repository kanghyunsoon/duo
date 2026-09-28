/**
 * Codex adapter (TASK-017). Project-scoped MCP servers live in <repo>/.codex/config.toml, read only
 * when the project is trusted (DUO never changes trust). The official `codex mcp add` writes the user's
 * ~/.codex/config.toml, so DUO edits the project file instead: a DUO-managed block of whole-line
 * markers appended at the end, so human TOML and comments outside it stay byte-identical (no
 * re-serialization). TOML is parsed (smol-toml) only to check the file and the merged result.
 *
 * Codex starts project stdio servers in the session's working directory (a relative cwd resolves
 * against it), so the entry has no cwd and asks duoctl for --root-from git-cwd: the top level of the
 * Git work tree around the session. No absolute path is recorded (clone/move safe).
 */
import { parse as parseToml } from "smol-toml";
import { isDuoLaunch, sameLaunch, SERVER_NAME, type AgentIntegrationAdapter } from "./adapter.js";
import { findBlock, removeBlock, upsertBlock, type Markers } from "./managed-block.js";
import type { McpInspection, McpLaunchEntry } from "./types.js";

export const CODEX_MARKERS: Markers = { begin: "# duo-director:begin", end: "# duo-director:end" };

const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string for these ASCII-safe values

function blockLines(entry: McpLaunchEntry): string[] {
  return [
    CODEX_MARKERS.begin,
    "# Managed by duoctl install codex. Edit outside this block; duoctl install remove codex deletes it.",
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    CODEX_MARKERS.end,
  ];
}

function parse(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    return { ok: true, value: parseToml(text) as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: `not valid TOML: ${(error as Error).message.split("\n")[0] ?? ""}` };
  }
}

function entryOf(config: Record<string, unknown>): unknown {
  const servers = config.mcp_servers;
  return servers !== null && typeof servers === "object" ? (servers as Record<string, unknown>)[SERVER_NAME] : undefined;
}

function asLaunch(entry: unknown): McpLaunchEntry | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const e = entry as { command?: unknown; args?: unknown };
  return typeof e.command === "string" && Array.isArray(e.args) && e.args.every((a) => typeof a === "string") ? { command: e.command, args: e.args as string[] } : undefined;
}

const exactly = (entry: unknown, planned: McpLaunchEntry) => {
  const launch = asLaunch(entry);
  return launch !== undefined && sameLaunch(launch, planned) && Object.keys(entry as object).every((k) => k === "command" || k === "args");
};

export const codexAdapter: AgentIntegrationAdapter = {
  id: "codex",
  mcpTarget: ".codex/config.toml",
  bridgeTarget: "AGENTS.md",
  projectTrustRequired: true,
  approvalRequired: false,
  plannedEntry: (launcher) => ({ command: launcher.command, args: [...launcher.argsPrefix, "mcp", "--root-from", "git-cwd", "--agent", "codex"] }),
  inspect(text, planned): McpInspection {
    if (text === undefined) return { status: "not-configured", managed: false };
    const parsed = parse(text);
    if (!parsed.ok) return { status: "conflict", managed: false, reason: parsed.reason };
    const block = findBlock(text, CODEX_MARKERS);
    if (block.kind === "malformed") return { status: "conflict", managed: false, reason: `DUO markers: ${block.reason}` };
    const entry = entryOf(parsed.value);
    if (block.kind === "one") {
      const inside = parse(block.text);
      const own = inside.ok ? entryOf(inside.value) : undefined;
      if (own === undefined) return { status: "conflict", managed: true, reason: "the DUO-managed block does not define the server (or it is defined elsewhere too)" };
      return exactly(entry, planned) ? { status: "already-configured", managed: true, current: entry } : { status: "drifted", managed: true, current: entry };
    }
    if (entry === undefined) return { status: "not-configured", managed: false };
    if (exactly(entry, planned)) return { status: "already-configured", managed: false, current: entry };
    if (isDuoLaunch(entry)) return { status: "compatible-different-format", managed: false, current: entry, reason: `[mcp_servers.${SERVER_NAME}] is a DUO launch outside the DUO-managed block; DUO does not rewrite human TOML: remove that table and install again` };
    return { status: "conflict", managed: false, current: entry, reason: `[mcp_servers.${SERVER_NAME}] already starts another command` };
  },
  write(text, planned) {
    const next = upsertBlock(text, blockLines(planned), CODEX_MARKERS);
    const check = parse(next);
    return check.ok && exactly(entryOf(check.value), planned) ? next : undefined;
  },
  remove(text) {
    const next = removeBlock(text, CODEX_MARKERS);
    if (next === undefined) return undefined;
    return next.trim() === "" ? null : next;
  },
  readEntry(text) {
    const parsed = parse(text);
    return parsed.ok ? asLaunch(entryOf(parsed.value)) : undefined;
  },
  launchEnvironment: (root) => ({ cwd: root, env: {} }),
};

export const codexBlockLines = blockLines;
