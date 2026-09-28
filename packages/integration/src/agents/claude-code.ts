/**
 * Claude Code adapter (TASK-017). Project-scoped servers live in <repo>/.mcp.json (shared through the
 * repository); Claude Code asks the user to approve them, which DUO never does on the user's behalf.
 * The file is JSON (no comments): DUO parses it, sets only mcpServers["duo-director"] and writes it
 * back with the file's own indentation and line endings, so other keys and servers keep their values
 * and order.
 *
 * Claude Code sets CLAUDE_PROJECT_DIR (the project root) in the environment of the stdio servers it
 * starts, so the entry asks duoctl for --root-from env:CLAUDE_PROJECT_DIR: no absolute path, no
 * ${...} expansion in the configuration.
 */
import { isDuoLaunch, sameLaunch, SERVER_NAME, type AgentIntegrationAdapter } from "./adapter.js";
import type { McpInspection, McpLaunchEntry } from "./types.js";

type Json = Record<string, unknown>;

function parse(text: string): { ok: true; value: Json } | { ok: false; reason: string } {
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: ".mcp.json is not a JSON object" };
    const servers = (v as Json).mcpServers;
    if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) return { ok: false, reason: "mcpServers is not an object" };
    return { ok: true, value: v as Json };
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${(error as Error).message}` };
  }
}

const entryOf = (config: Json): unknown => (config.mcpServers as Json | undefined)?.[SERVER_NAME];

function planned(entry: McpLaunchEntry): Json {
  return { type: "stdio", command: entry.command, args: [...entry.args] };
}

function exactly(entry: unknown, want: McpLaunchEntry): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Json;
  const keys = Object.keys(e).sort();
  return JSON.stringify(keys) === JSON.stringify(["args", "command", "type"]) && e.type === "stdio" && typeof e.command === "string" && Array.isArray(e.args)
    && sameLaunch({ command: e.command, args: e.args as string[] }, want);
}

function serialize(value: Json, original: string | undefined): string {
  const indent = original === undefined ? "  " : /^([ \t]+)"/mu.exec(original)?.[1] ?? "  ";
  const eol = original?.includes("\r\n") === true ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, indent).replace(/\n/gu, eol);
  return original === undefined || /\r?\n$/u.test(original) ? body + eol : body;
}

export const claudeCodeAdapter: AgentIntegrationAdapter = {
  id: "claude-code",
  mcpTarget: ".mcp.json",
  bridgeTarget: "CLAUDE.md",
  projectTrustRequired: false,
  approvalRequired: true,
  plannedEntry: (launcher) => ({ type: "stdio", command: launcher.command, args: [...launcher.argsPrefix, "mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"] }),
  inspect(text, want): McpInspection {
    if (text === undefined) return { status: "not-configured", managed: false };
    const parsed = parse(text);
    if (!parsed.ok) return { status: "conflict", managed: false, reason: parsed.reason };
    const entry = entryOf(parsed.value);
    if (entry === undefined) return { status: "not-configured", managed: false };
    if (exactly(entry, want)) return { status: "already-configured", managed: true, current: entry };
    if (isDuoLaunch(entry)) return { status: "compatible-different-format", managed: true, current: entry, reason: "an older or different DUO launch; it is replaced with the planned entry" };
    return { status: "conflict", managed: false, current: entry, reason: `mcpServers["${SERVER_NAME}"] already starts another command` };
  },
  write(text, want) {
    const base = text === undefined ? { ok: true as const, value: {} as Json } : parse(text);
    if (!base.ok) return undefined;
    const servers = { ...((base.value.mcpServers as Json | undefined) ?? {}), [SERVER_NAME]: planned(want) };
    return serialize({ ...base.value, mcpServers: servers }, text);
  },
  remove(text) {
    const parsed = parse(text);
    if (!parsed.ok) return undefined;
    const servers = parsed.value.mcpServers as Json | undefined;
    if (servers === undefined || !(SERVER_NAME in servers) || !isDuoLaunch(servers[SERVER_NAME])) return undefined;
    const rest = Object.fromEntries(Object.entries(servers).filter(([k]) => k !== SERVER_NAME));
    const next: Json = { ...parsed.value, mcpServers: rest };
    if (Object.keys(rest).length === 0 && Object.keys(next).length === 1) return null;
    return serialize(next, text);
  },
  readEntry(text) {
    const parsed = parse(text);
    if (!parsed.ok) return undefined;
    const e = entryOf(parsed.value) as Json | undefined;
    return e !== undefined && typeof e.command === "string" && Array.isArray(e.args) ? { command: e.command, args: e.args as string[] } : undefined;
  },
  launchEnvironment: (root) => ({ cwd: root, env: { CLAUDE_PROJECT_DIR: root } }),
};
