/**
 * MCP end-to-end support (TASK-016): the built duoctl started as a real stdio MCP server
 * (duoctl mcp --root <repo>) and driven by the official MCP client over the wire. Build first.
 */
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CLI_MAIN } from "../cli/support.js";

export interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tests assert the payload shape
  readonly structuredContent?: any;
}

export interface McpSession {
  readonly client: Client;
  readonly pid: number | null;
  stderr(): string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export async function startMcp(root: string, extra: readonly string[] = []): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [CLI_MAIN, "mcp", "--root", root, ...extra], cwd: root, stderr: "pipe",
    env: { ...getDefaultEnvironment(), DUO_LOCALE: "" },
  });
  let err = "";
  transport.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
  const client = new Client({ name: "duo-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    client, pid: transport.pid, stderr: () => err,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    close: () => client.close(),
  };
}
