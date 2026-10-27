import fs from "node:fs";
import { Server } from "../../../packages/integration/node_modules/@modelcontextprotocol/server/dist/index.mjs";
import { StdioServerTransport } from "../../../packages/integration/node_modules/@modelcontextprotocol/server/dist/stdio.mjs";
import { expectedOutputProperties, expectedSchemas } from "../../../bench/mcp-contract.mjs";

const mode = process.env.DUO_MCP_BENCHMARK_FAKE_MODE;
fs.appendFileSync(process.env.DUO_MCP_BENCHMARK_PID_FILE, `${process.pid}\n`);

if (mode === "initialize") {
  process.stdin.resume();
  setInterval(() => undefined, 1_000);
} else {
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
