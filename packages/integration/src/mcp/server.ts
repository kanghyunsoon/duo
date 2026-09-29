/**
 * duo-director MCP server (TASK-016): stdio transport for a local coding agent. The server manages
 * exactly one repository, given explicitly at startup and checked to be the top level of a Git work
 * tree. stdout is the protocol; diagnostics go to stderr. Every tool call opens and closes its own
 * graph access (no pinned SQLite snapshot, no open transaction between calls).
 */
import { openGitProvider } from "@duo-director/analyzer";
import { createDiagnostic, failure, MCP_SERVER_NAME, success, type ParseResult } from "@duo-director/core";
import { appendRuntimeMetric, type TokenCountMemo } from "@duo-director/director";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { NOT_INITIALIZED_FORMAT } from "../operations/common.js";
import { LLMProviderPool } from "../llm/factory.js";
import { INPUT, OUTPUT, TOOLS, type ToolContext, type ToolName, type ToolRun } from "./tools.js";

/**
 * Server-wide guidance returned at initialization (MCP instructions). A few principles only; the
 * workflow lives in the Agent bridge (AGENTS.md / CLAUDE.md, TASK-017). The first 512 characters are
 * self-contained.
 */
export const MCP_INSTRUCTIONS = [
  "DUO holds this repository's confirmed project direction (Project Truth).",
  "Call duo_get_context before substantial implementation and duo_review_changes after changes.",
  "Tools never index: on index-required, run `duoctl index` and call again.",
  "Pending proposals and surfaced gaps are not confirmed decisions or instructions.",
  "Agents can only propose decisions (duo_propose_decision); a human confirms or rejects.",
].join(" ");

/** Replaces a tool's operation (test injection only: cancellation and failure isolation tests). */
export type ToolOverride = (args: unknown, ctx: ToolContext) => Promise<ToolRun>;

export interface DuoMcpOptions {
  /** Canonical repository root (the top level of its Git work tree). */
  readonly root: string;
  /** Audit label for proposals ("agent"); not an authentication. */
  readonly agentName?: string;
  readonly version: string;
  /** Where diagnostics go (default stderr). Never stdout. */
  readonly log?: (line: string) => void;
  /** Test injection: replaces the operation behind a tool. The tool list and schemas stay the same. */
  readonly toolOverrides?: Partial<Record<ToolName, ToolOverride>>;
  /**
   * LLM providers (T12B). Default: one pool over the environment as it is when the server starts,
   * kept for the server's lifetime (a new API key needs a restart). Tests inject a fake transport here.
   */
  readonly llm?: LLMProviderPool;
}

const METERED = new Set<ToolName>(["duo_get_context", "duo_review_changes", "duo_propose_decision"]);

export function createDuoMcpServer(options: DuoMcpOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: options.version }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const llm = options.llm ?? new LLMProviderPool(process.env);
  // Repository token counts for Context metrics, kept in memory for the server's lifetime (TASK-019, C145).
  const tokenCounts: TokenCountMemo = new Map();
  for (const name of Object.keys(TOOLS) as ToolName[]) {
    const tool = TOOLS[name];
    // The SDK's registerTool overloads are generic per schema; this loop registers heterogeneous tools through
    // one loosely typed signature. Inputs are still validated by the strict zod schemas.
    const register = server.registerTool.bind(server) as unknown as (
      n: string, config: Record<string, unknown>, cb: (args: unknown, ctx: ServerContext) => Promise<CallToolResult>,
    ) => void;
    register(name, {
      title: tool.title, description: tool.description, inputSchema: INPUT[name], outputSchema: OUTPUT[name],
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
    }, async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
      const started = Date.now();
      const toolCtx: ToolContext = { root: options.root, agentName: options.agentName ?? "agent", signal: ctx.mcpReq.signal, llm, tokenCounts };
      const operation = options.toolOverrides?.[name] ?? (tool.run as ToolOverride);
      let run: ToolRun;
      try {
        run = await operation(args, toolCtx);
      } catch (error) {
        // An unexpected exception fails this invocation only; the server keeps serving (T16.1).
        const message = error instanceof Error ? error.message : String(error);
        log(`${MCP_SERVER_NAME}: INTERNAL ${name}: ${message}`);
        run = { op: { kind: "failed", diagnostics: [createDiagnostic("MCP_INTERNAL_ERROR", `${name} failed unexpectedly: ${message}`)] } };
      }
      if (METERED.has(name)) {
        const written = await appendRuntimeMetric(options.root, {
          format: "duo.metric/1", surface: "mcp", command: name, status: String(run.metric?.status ?? run.op.kind), exitCode: run.op.kind === "failed" ? 1 : 0,
          durationMs: Date.now() - started, at: new Date().toISOString(), ...(run.metric ?? {}),
        });
        for (const d of written.diagnostics) log(`${MCP_SERVER_NAME}: ${d.code}: ${d.message}`);
      }
      if (run.op.kind === "failed") {
        return { isError: true, content: [{ type: "text", text: run.op.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n") || "operation failed" }] };
      }
      const payload = run.op.kind === "ok"
        ? run.op.payload as Record<string, unknown>
        : { format: NOT_INITIALIZED_FORMAT, status: "not-initialized", message: "Not a DUO project yet (no .duo-project/project.yaml). A human runs duoctl init." };
      const summary = run.op.kind === "ok" ? tool.summarize(payload) : String(payload.message);
      return { content: [{ type: "text", text: summary }], structuredContent: payload };
    });
  }
  return server;
}

export interface DuoMcpHandle {
  /** Resolves when the connection ends (stdin closed by the client, or close() / a termination signal). */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Validates the root and serves duo-director over this process's stdio. The root must be the top level
 * of a Git work tree (GIT_REPOSITORY_REQUIRED / SCAN_ROOT_INVALID otherwise): one server manages one
 * repository. The connection ends when the client closes stdin, or on SIGINT / SIGTERM.
 */
export async function serveDuoMcp(options: DuoMcpOptions): Promise<ParseResult<DuoMcpHandle>> {
  const git = await openGitProvider(options.root);
  if (git.value === undefined) {
    return failure(git.diagnostics.length > 0 ? git.diagnostics : [createDiagnostic("GIT_REPOSITORY_REQUIRED", `${options.root} is not a Git repository`)]);
  }
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  // One environment snapshot and provider pool for the server's lifetime (T12B, C192).
  const serverOptions = { ...options, llm: options.llm ?? new LLMProviderPool(process.env) };
  const handle = serveStdio(() => createDuoMcpServer(serverOptions), { onerror: (e) => log(`${MCP_SERVER_NAME}: ${e.message}`) });
  let finish = () => {};
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= handle.close().catch((e: unknown) => log(`${MCP_SERVER_NAME}: ${(e as Error).message}`)).finally(() => {
      process.stdin.off("end", onEnd).off("close", onEnd);
      process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
      finish();
    });
    return closing;
  };
  const onEnd = () => { void close(); };
  const onSignal = () => { void close(); };
  process.stdin.on("end", onEnd).on("close", onEnd);
  process.on("SIGINT", onSignal).on("SIGTERM", onSignal);
  return success({ closed, close });
}
