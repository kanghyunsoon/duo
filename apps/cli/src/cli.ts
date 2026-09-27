/**
 * duo CLI — thin entry point (ADR-010, REQ-CLI-001).
 * Parses arguments and formats output only. Commands are implemented in packages (TASK-015).
 */
import { packageInfo as analyzer } from "@duo/analyzer";
import { packageInfo as core, type PackageInfo } from "@duo/core";
import { packageInfo as director } from "@duo/director";
import { packageInfo as graph } from "@duo/graph";
import { packageInfo as integration } from "@duo/integration";
import { VERSION } from "./version.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** Commands defined in docs/07-cli-interface.md. None is implemented in T01. */
export const PLANNED_COMMANDS = [
  "init", "status", "context", "review", "decision", "trace", "impact", "stats", "ui", "install", "mcp",
] as const;

const WORKSPACE: readonly PackageInfo[] = [core, analyzer, graph, director, integration];

const HELP = [
  `duo ${VERSION} — AI Project Direction Layer for Coding Agents`,
  "",
  "Usage: duo <command> [options]",
  "",
  `Commands (not implemented yet): ${PLANNED_COMMANDS.join(", ")}`,
  "",
  "Options:",
  "  --version, -v   Print version (with --json: workspace packages)",
  "  --help, -h      Print this help",
  "  --json          Machine-readable output",
].join("\n");

export function run(argv: readonly string[], io: Io): number {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");

  if (args.includes("--version") || args.includes("-v")) {
    io.out(json
      ? JSON.stringify({ name: "duo", version: VERSION, packages: WORKSPACE.map((p) => p.name) })
      : `duo ${VERSION}`);
    return 0;
  }
  const [command] = args;
  if (command === undefined || args.includes("--help") || args.includes("-h")) {
    io.out(HELP);
    return 0;
  }
  if ((PLANNED_COMMANDS as readonly string[]).includes(command)) {
    io.err(`duo: '${command}' is not implemented yet (docs/07-cli-interface.md)`);
    return 1;
  }
  io.err(`duo: unknown command '${command}'. Run 'duo --help'.`);
  return 1;
}
