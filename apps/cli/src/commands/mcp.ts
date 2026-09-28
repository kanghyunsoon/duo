/**
 * duoctl mcp (TASK-016, T17): serves the duo-director MCP server over stdio for one repository. The
 * root is explicit: --root <path> (default the working directory) or --root-from git-cwd | env:<NAME>,
 * and it must be the top level of its Git work tree. stdout carries only the MCP protocol, so this
 * command prints nothing there and writes no CLI metric; tool calls meter themselves (surface "mcp").
 */
import type { Diagnostic } from "@duo-director/core";
import { resolveMcpRoot, serveDuoMcp } from "@duo-director/integration";
import { VERSION } from "../version.js";
import { EXIT, failed, type Outcome } from "../output.js";
import type { Env } from "./shared.js";

export interface McpOptions {
  readonly root?: string;
  readonly rootFrom?: string;
  readonly agent?: string;
}

export async function mcpCommand(env: Env, options: McpOptions): Promise<Outcome> {
  const fail = (d: readonly Diagnostic[]) => failed("mcp", EXIT.ERROR, d, d.map((x) => `${x.code}: ${x.message}`));
  const root = await resolveMcpRoot({ ...(options.root === undefined ? {} : { root: options.root }), ...(options.rootFrom === undefined ? {} : { rootFrom: options.rootFrom }) }, { cwd: env.io.cwd(), env: env.io.env });
  if (root.value === undefined) return fail(root.diagnostics);
  const served = await serveDuoMcp({
    root: root.value, version: VERSION, log: (line) => env.io.err(line), ...(options.agent === undefined ? {} : { agentName: options.agent }),
  });
  if (served.value === undefined) return fail(served.diagnostics);
  await served.value.closed;
  return { command: "mcp", exitCode: EXIT.OK, result: null, diagnostics: [], human: [] };
}
