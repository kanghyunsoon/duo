import fs from "node:fs";

// Record this process before loading the SDK, so a slow start cannot delay it past a short client timeout.
// DUO_MCP_BENCHMARK_SERVER_PID_FILE lets a test break the benchmark's own PID file while still seeing this process.
fs.appendFileSync(process.env.DUO_MCP_BENCHMARK_SERVER_PID_FILE || process.env.DUO_MCP_BENCHMARK_PID_FILE, `${process.pid}\n`);
const mode = process.env.DUO_MCP_BENCHMARK_FAKE_MODE;

if (mode === "initialize") {
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
} else {
  const { Server } = await import("../../../packages/integration/node_modules/@modelcontextprotocol/server/dist/index.mjs");
  const { StdioServerTransport } = await import("../../../packages/integration/node_modules/@modelcontextprotocol/server/dist/stdio.mjs");
  const { expectedOutputProperties, expectedSchemas } = await import("../../../bench/mcp-contract.mjs");

  const server = new Server({ name: "unresponsive-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => {
    if (mode === "tools/list") return new Promise(() => undefined);
    return {
      tools: Object.entries(expectedSchemas).map(([name, schema]) => ({
        name,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: schema.required,
          properties: Object.fromEntries(Object.entries(schema.properties).map(([property, type]) => [property, schema.nested?.[property]
            ? { type, additionalProperties: false, properties: Object.fromEntries(Object.entries(schema.nested[property]).map(([child, childType]) => [child, { type: childType }])) }
            : { type }])),
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["format"],
          properties: Object.fromEntries(expectedOutputProperties[name].map((property) => [property, property === "format" ? { type: "string" } : {}])),
        },
      })),
    };
  });
  server.setRequestHandler("tools/call", async (request) => request.params.name === "duo_get_context"
    ? new Promise(() => undefined)
    : { content: [{ type: "text", text: "{}" }], structuredContent: { format: "fake" } });
  await server.connect(new StdioServerTransport());
}
