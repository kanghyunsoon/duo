/**
 * duoctl (T15, REQ-CLI-001): a thin orchestration layer. It parses arguments, asks questions, renders
 * results and maps them to exit codes; every operation is a call into core, analyzer, graph and
 * director services. The CLI holds no domain logic and does no file or process I/O of its own.
 *
 * Global options: --root <path>, --json, --locale en|ko, --non-interactive, --verbose, --help, --version.
 * --json prints one envelope { format: "duo.cli.<command>/1", command, ok, exitCode, result, diagnostics }.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { packageInfo as analyzer } from "@duo-director/analyzer";
import { CLI_NAME, createDiagnostic, packageInfo as core, PRODUCT_NAME, SUPPORTED_SCHEMA_VERSIONS, type Diagnostic, type PackageInfo } from "@duo-director/core";
import { appendRuntimeMetric, packageInfo as director } from "@duo-director/director";
import { GRAPH_SCHEMA_VERSION, packageInfo as graph } from "@duo-director/graph";
import { packageInfo as integration } from "@duo-director/integration";
import { contextCommand } from "./commands/context.js";
import { decisionCommand } from "./commands/decision.js";
import { doctorCommand } from "./commands/doctor.js";
import { graphCommand } from "./commands/graph.js";
import { indexCommand } from "./commands/index-command.js";
import { initCommand } from "./commands/init.js";
import { installCommand } from "./commands/install.js";
import { mcpCommand } from "./commands/mcp.js";
import { reviewCommand } from "./commands/review.js";
import { uiCommand } from "./commands/ui.js";
import { CliFailure, usage, type Env } from "./commands/shared.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import type { Io } from "./io.js";
import { parseLocale, t } from "./messages.js";
import { envelope, EXIT, failed, type Outcome } from "./output.js";
import { VERSION } from "./version.js";

export type { Io } from "./io.js";

export const COMMANDS = ["init", "status", "doctor", "index", "context", "review", "trace", "impact", "decision", "stats", "ui", "install", "mcp"] as const;
const LATER: Readonly<Record<string, string>> = {};
/** Commands that append runtime/metrics.jsonl. Read-only commands (status, doctor, trace, impact, stats) write nothing. */
const METERED = new Set(["init", "index", "context", "review", "decision", "install"]);

const WORKSPACE: readonly PackageInfo[] = [core, analyzer, graph, director, integration];

type Options = NonNullable<ParseArgsConfig["options"]>;
const GLOBAL: Options = {
  root: { type: "string" }, json: { type: "boolean" }, locale: { type: "string" }, "non-interactive": { type: "boolean" },
  verbose: { type: "boolean" }, "no-color": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
};
const COMMAND_OPTIONS: Readonly<Record<string, Options>> = {
  init: { yes: { type: "boolean", short: "y" }, repair: { type: "boolean" }, answers: { type: "string" }, "baseline-policy": { type: "string" } },
  status: {},
  doctor: {},
  index: { full: { type: "boolean" } },
  context: { budget: { type: "string" }, refresh: { type: "boolean" } },
  review: {
    staged: { type: "boolean" }, from: { type: "string" }, to: { type: "string" }, files: { type: "string" }, task: { type: "string" }, budget: { type: "string" },
    record: { type: "boolean" }, refresh: { type: "boolean" }, "fail-on": { type: "string" }, strict: { type: "boolean" }, semantic: { type: "boolean" },
  },
  trace: { depth: { type: "string" } },
  impact: { depth: { type: "string" } },
  decision: { reason: { type: "string" } },
  stats: { last: { type: "string" } },
  mcp: { agent: { type: "string" }, "root-from": { type: "string" } },
  install: { yes: { type: "boolean", short: "y" }, launcher: { type: "string" } },
  ui: { port: { type: "string" }, open: { type: "boolean" } },
};

const HELP = [
  `${PRODUCT_NAME} ${VERSION} — AI Project Direction Layer for Coding Agents`,
  "",
  `Usage: ${CLI_NAME} <command> [options]`,
  "",
  "Commands:",
  "  init        adopt this Git repository: plan, Truth, index, adoption baseline",
  "  status      Truth, index freshness, adoption baseline, pending decisions (read-only)",
  "  doctor      check the whole setup (Git, Truth, index, analysis, agents, optional LLM) and print the next steps (read-only)",
  "  index       update the Project Graph (--full: clean rebuild)",
  "  context     Context Packet for a task (--budget, --refresh)",
  "  review      review changes (--staged, --from, --to, --files, --task, --budget, --refresh, --record, --fail-on block|ask|warn, --strict = --fail-on warn, --semantic: optional LLM assistance)",
  "  trace       trace a node (--depth 1-3)",
  "  impact      Graph-recorded impact of a node (--depth 1-3)",
  "  decision    list | confirm <id> | reject <id> [--reason <text>] | review-pending (terminal only, a human: review-pending previews every pending proposal, then confirms the ones you choose)",
  "  stats       runtime metrics summary (--last n)",
  "  mcp         serve the duo-director MCP server over stdio (--root <path> | --root-from git-cwd|env:<NAME>, --agent <label>)",
  "  install     connect an agent: install codex|claude-code [--launcher path|npx] [--yes] · install status [agent] · install remove <agent>",
  "  ui          local Project Direction Console on 127.0.0.1 (--port <n>, --open); Ctrl+C stops it",
  "",
  "Options: --root <path>  --json  --locale en|ko  --non-interactive  --verbose  --no-color  --version  --help",
  "init: --yes (operational confirmations only; never Truth or the adoption policy)  --answers -  --baseline-policy head|abort  --repair",
].join("\n");

function parse(argv: readonly string[]) {
  const command = argv.find((a) => !a.startsWith("-"));
  const spec = { ...GLOBAL, ...(command === undefined ? {} : COMMAND_OPTIONS[command] ?? {}) };
  return { command, parsed: parseArgs({ args: [...argv], options: spec, allowPositionals: true, strict: true }) };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const bool = (v: unknown) => v === true;

async function dispatch(env: Env, command: string, positionals: readonly string[], v: Record<string, unknown>): Promise<Outcome> {
  const arg = positionals[1];
  switch (command) {
    case "init": {
      const answers = str(v.answers);
      if (answers !== undefined && answers !== "-") return usage("init", "--answers takes '-' (a JSON array of answers on stdin)");
      const policy = str(v["baseline-policy"]);
      if (policy !== undefined && policy !== "head" && policy !== "abort") return usage("init", "--baseline-policy must be head or abort");
      return initCommand(env, { repair: bool(v.repair), answersFromStdin: answers === "-", ...(policy === undefined ? {} : { baselinePolicy: policy }) });
    }
    case "status": return statusCommand(env);
    case "doctor": return doctorCommand(env);
    case "index": return indexCommand(env, bool(v.full));
    case "context": {
      const task = positionals.slice(1).join(" ").trim();
      if (task === "") return usage("context", "usage: duoctl context <task>");
      const budget = str(v.budget) === undefined ? undefined : Number(v.budget);
      if (budget !== undefined && !Number.isInteger(budget)) return usage("context", "--budget must be an integer");
      return contextCommand(env, task, { ...(budget === undefined ? {} : { budget }), refresh: bool(v.refresh) });
    }
    case "review": {
      const failOn = bool(v.strict) ? "warn" : str(v["fail-on"]);
      if (failOn !== undefined && failOn !== "block" && failOn !== "ask" && failOn !== "warn") return usage("review", "--fail-on must be block, ask or warn");
      const budget = str(v.budget) === undefined ? undefined : Number(v.budget);
      if (budget !== undefined && !Number.isInteger(budget)) return usage("review", "--budget must be an integer");
      const from = str(v.from); const to = str(v.to); const files = str(v.files); const task = str(v.task);
      return reviewCommand(env, {
        staged: bool(v.staged), record: bool(v.record), refresh: bool(v.refresh), semantic: bool(v.semantic),
        ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), ...(files === undefined ? {} : { files }), ...(task === undefined ? {} : { task }),
        ...(budget === undefined ? {} : { budget }), ...(failOn === undefined ? {} : { failOn }),
      });
    }
    case "trace":
    case "impact":
      if (arg === undefined) return usage(command, `usage: duoctl ${command} <node>`);
      return graphCommand(env, command, arg, str(v.depth));
    case "decision": return decisionCommand(env, arg, positionals[2], str(v.reason));
    case "stats": return statsCommand(env, str(v.last));
    case "install": return installCommand(env, arg, positionals[2], { ...(str(v.launcher) === undefined ? {} : { launcher: str(v.launcher) as string }) });
    case "ui":
      if (env.json) return usage("ui", "ui serves a local web console; --json does not apply");
      return uiCommand(env, { open: bool(v.open), ...(str(v.port) === undefined ? {} : { port: str(v.port) as string }) });
    case "mcp":
      // stdout is the MCP protocol: no JSON envelope, no human output on stdout.
      if (env.json) return usage("mcp", "mcp speaks the MCP protocol on stdout; --json does not apply");
      {
        const root = str(v.root); const rootFrom = str(v["root-from"]); const agent = str(v.agent);
        return mcpCommand(env, { ...(root === undefined ? {} : { root }), ...(rootFrom === undefined ? {} : { rootFrom }), ...(agent === undefined ? {} : { agent }) });
      }
    default: return failed(command, EXIT.ERROR, [], [t(env.locale, "not-implemented", { command, task: LATER[command] ?? "" })]);
  }
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let command: string | undefined;
  let parsed;
  try {
    ({ command, parsed } = parse(argv));
  } catch (error) {
    io.err(`${CLI_NAME}: ${(error as Error).message}`);
    return EXIT.ERROR;
  }
  const v = parsed.values as Record<string, unknown>;
  const json = bool(v.json);
  if (bool(v.version)) {
    io.out(json ? JSON.stringify({
      name: CLI_NAME, version: VERSION, packages: WORKSPACE.map((p) => p.name),
      graphSchemaVersion: GRAPH_SCHEMA_VERSION, projectSchemaVersions: SUPPORTED_SCHEMA_VERSIONS, node: process.version,
    }) : `${CLI_NAME} ${VERSION}`);
    return EXIT.OK;
  }
  if (command === undefined || bool(v.help)) {
    io.out(HELP);
    return EXIT.OK;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    io.err(`${CLI_NAME}: unknown command '${command}'. Run '${CLI_NAME} --help'.`);
    return EXIT.ERROR;
  }
  const locale = parseLocale(str(v.locale) ?? io.env.DUO_LOCALE) ?? "en";
  const env: Env = {
    root: str(v.root) ?? io.cwd(), json, locale, nonInteractive: bool(v["non-interactive"]), yes: bool(v.yes), verbose: bool(v.verbose), io,
  };
  const started = io.now().getTime();
  let outcome: Outcome;
  try {
    outcome = await dispatch(env, command, parsed.positionals, v);
  } catch (error) {
    const diagnostics = error instanceof CliFailure ? error.diagnostics : [createDiagnostic("CLI_USAGE_INVALID", (error as Error).message)];
    outcome = failed(command, EXIT.ERROR, diagnostics, diagnostics.map((d) => `${d.code}: ${d.message}`), null, { status: "failed" });
  }
  // Metrics are a separate, local observation: a failed write warns and never changes the result.
  const extra: Diagnostic[] = [];
  if (outcome.metric !== undefined && METERED.has(command)) {
    const written = await appendRuntimeMetric(env.root, {
      format: "duo.metric/1", command, exitCode: outcome.exitCode, durationMs: io.now().getTime() - started, at: io.now().toISOString(), ...outcome.metric,
    });
    extra.push(...written.diagnostics);
    for (const d of written.diagnostics) io.err(`${CLI_NAME}: ${d.code}: ${d.message}`);
  }
  if (json) io.out(JSON.stringify(envelope(outcome, extra), null, 2));
  else for (const line of outcome.human) (outcome.exitCode === EXIT.OK ? io.out : io.err)(line);
  return outcome.exitCode;
}
