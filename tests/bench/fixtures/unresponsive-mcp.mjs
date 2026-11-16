import fs from "node:fs";

// Record this process before loading the fixture contract, so startup cannot hide it from cleanup assertions.
// DUO_MCP_BENCHMARK_SERVER_PID_FILE lets a test break the benchmark's own PID file while still seeing this process.
fs.appendFileSync(process.env.DUO_MCP_BENCHMARK_SERVER_PID_FILE || process.env.DUO_MCP_BENCHMARK_PID_FILE, `${process.pid}\n`);
const mode = process.env.DUO_MCP_BENCHMARK_FAKE_MODE;

if (mode === "initialize") {
  process.stdin.resume();
} else {
  const { createInterface } = await import("node:readline");
  const { expectedOutputProperties, expectedSchemas } = await import("../../../bench/mcp-contract.mjs");
  const tools = Object.entries(expectedSchemas).map(([name, schema]) => ({
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
  }));
  const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      send(request.id, {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "unresponsive-mcp", version: "1.0.0" },
      });
    } else if (request.method === "tools/list") {
      if (mode !== "tools/list") send(request.id, { tools });
    } else if (request.method === "tools/call") {
      if (mode !== "tools/call" || request.params?.name !== "duo_get_context") {
        send(request.id, { content: [{ type: "text", text: "{}" }], structuredContent: { format: "fake" } });
      }
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
    }
  });
}

// A timeout must be followed by benchmark-owned cleanup, not a cooperative fixture exit on stdin end.
setInterval(() => undefined, 1_000);
