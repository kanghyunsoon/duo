/**
 * Starts an MCP server exactly as a configuration describes it (executable + args, working directory,
 * environment; no shell string) and checks it with the official client: initialize, tools/list and
 * duo_get_status. Used by agent integration verification (TASK-017). The server is closed afterwards.
 */
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export interface McpLaunchProbe {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Added to a minimal inherited environment (PATH and the platform's safe variables). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type McpProbeResult =
  | { readonly ok: true; readonly serverName: string; readonly serverVersion: string; readonly tools: readonly string[]; readonly status: Record<string, unknown> | null }
  | { readonly ok: false; readonly error: string; readonly stderr: string };

export async function probeMcpLaunch(probe: McpLaunchProbe): Promise<McpProbeResult> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: probe.command, args: [...probe.args], cwd: probe.cwd, stderr: "pipe",
    env: { ...getDefaultEnvironment(), ...(probe.env ?? {}) },
  });
  transport.stderr?.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-4000); });
  const client = new Client({ name: "duoctl-install-verify", version: "1" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${probe.timeoutMs ?? 30_000} ms`)), probe.timeoutMs ?? 30_000); });
  try {
    const result = await Promise.race([(async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const status = await client.callTool({ name: "duo_get_status", arguments: {} });
      return {
        ok: true as const, serverName: client.getServerVersion()?.name ?? "", serverVersion: client.getServerVersion()?.version ?? "", tools: tools.map((t) => t.name).sort(),
        status: status.isError === true ? null : (status.structuredContent as Record<string, unknown> | undefined) ?? null,
      };
    })(), timeout]);
    return result;
  } catch (error) {
    return { ok: false, error: (error as Error).message, stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
