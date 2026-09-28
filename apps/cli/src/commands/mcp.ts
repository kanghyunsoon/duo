/**
 * duoctl mcp (TASK-016): serves the duo-director MCP server over stdio for one repository (--root, or
 * the working directory, which must be the top level of its Git work tree). stdout carries only the
 * MCP protocol, so this command prints nothing and writes no CLI metric; tool calls meter themselves
 * with surface "mcp".
 */
import { serveDuoMcp } from "@duo-director/integration";
import { VERSION } from "../version.js";
import { EXIT, failed, type Outcome } from "../output.js";
import type { Env } from "./shared.js";

export async function mcpCommand(env: Env, agentName: string | undefined): Promise<Outcome> {
  const served = await serveDuoMcp({
    root: env.root, version: VERSION, log: (line) => env.io.err(line), ...(agentName === undefined ? {} : { agentName }),
  });
  if (served.value === undefined) {
    return failed("mcp", EXIT.ERROR, served.diagnostics, served.diagnostics.map((d) => `${d.code}: ${d.message}`));
  }
  await served.value.closed;
  return { command: "mcp", exitCode: EXIT.OK, result: null, diagnostics: [], human: [] };
}
