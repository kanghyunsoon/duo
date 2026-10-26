import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(workspace, "apps", "cli", "dist", "main.js");
const fixture = path.join(workspace, "fixtures", "context", "app");
const smoke = process.argv.includes("--smoke");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number.parseInt(process.argv[index + 1] ?? "", 10);
};
const iterations = option("--iterations", smoke ? 1 : 10);
const concurrency = option("--concurrency", smoke ? 2 : 8);
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--iterations and --concurrency must be positive integers");
}

const toolArguments = {
  duo_get_status: {},
  duo_get_context: { task: "AUTH-03" },
  duo_review_changes: { task: "AUTH-03" },
  duo_get_requirement: { id: "AUTH-03" },
  duo_get_decision: { id: "D-004" },
  duo_trace: { node: "src/auth/AuthService.ts", depth: 1 },
  duo_impact: { node: "src/auth/AuthService.ts", depth: 1 },
  duo_search_evidence: { query: "AUTH-03", limit: 5 },
  duo_propose_decision: { title: "MCP benchmark proposal", question: "benchmark-only", answer: "Discard with the temporary fixture.", agent: "mcp-benchmark" },
};
const expectedSchemas = {
  duo_get_status: { required: [], properties: {} },
  duo_get_context: { required: ["task"], properties: { budget: "integer", profile: "string", task: "string" } },
  duo_review_changes: { required: [], properties: { budget: "integer", files: "array", from: "string", includeSemanticAssist: "boolean", task: "string", to: "string" } },
  duo_get_requirement: { required: ["id"], properties: { id: "string" } },
  duo_get_decision: { required: ["id"], properties: { id: "string" } },
  duo_trace: { required: ["node"], properties: { depth: "integer", node: "string" } },
  duo_impact: { required: ["node"], properties: { depth: "integer", node: "string" } },
  duo_search_evidence: { required: ["query"], properties: { limit: "integer", query: "string" } },
  duo_propose_decision: {
    required: ["answer", "question", "title"],
    properties: { agent: "string", answer: "string", enforcement: "string", forbids: "object", governs: "object", question: "string", rationale: "string", supersedes: "string", title: "string" },
    nested: {
      forbids: { dependencies: "array", imported_paths: "array", paths: "array", symbols: "array" },
      governs: { paths: "array", requirements: "array", symbols: "array" },
    },
  },
};
const expectedOutputProperties = {
  duo_get_status: ["analysis", "baseline", "format", "index", "initialized", "llm", "llmProvider", "message", "pendingDecisions", "project", "status", "truth"],
  duo_get_context: ["context", "format", "gaps", "message", "status"],
  duo_review_changes: ["baseline", "claims", "context", "diagnostics", "diff", "evidence", "format", "freshness", "gaps", "limitations", "message", "metrics", "request", "seeds", "semanticAssist", "status", "verdict", "verdictBasis"],
  duo_get_requirement: ["format", "id", "message", "requirement", "status", "text"],
  duo_get_decision: ["decision", "format", "id", "message", "note", "status", "text"],
  duo_trace: ["depth", "edges", "format", "index", "message", "node", "nodes", "status", "truncated"],
  duo_impact: ["depth", "evidence", "format", "index", "items", "limitations", "message", "node", "notice", "seeds", "status", "truncated"],
  duo_search_evidence: ["candidates", "format", "message", "notice", "query", "status", "truncated"],
  duo_propose_decision: ["basedOn", "confirmed", "format", "indexRequired", "message", "notice", "path", "proposalId", "proposedBy", "state", "status"],
};
const expectedNames = Object.keys(toolArguments).sort();

function command(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function prepareTemplate(temp) {
  const root = path.join(temp, "template");
  fs.cpSync(fixture, root, { recursive: true });
  command("git", ["init", "-q"], root);
  command("git", ["config", "user.email", "benchmark@invalid.local"], root);
  command("git", ["config", "user.name", "MCP Benchmark"], root);
  command("git", ["add", "-A"], root);
  command("git", ["commit", "-qm", "fixture"], root);
  command(process.execPath, [cli, "index"], root);
  return root;
}

function copyFixture(template, root) {
  fs.cpSync(template, root, { recursive: true });
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(samples) {
  const values = {};
  for (const sample of samples) {
    for (const [name, ms] of Object.entries(sample.latencyMs)) (values[name] ??= []).push(ms);
  }
  return Object.fromEntries(Object.entries(values).map(([name, times]) => [name, {
    count: times.length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
  }]));
}

function verifyTools(tools) {
  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error(`tool names differ: ${JSON.stringify(names)}`);
  for (const tool of tools) {
    const schema = tool.inputSchema;
    const expected = expectedSchemas[tool.name];
    const properties = Object.keys(schema.properties ?? {}).sort();
    if (schema.type !== "object" || schema.additionalProperties !== false) throw new Error(`${tool.name} input schema is not a strict object`);
    if (JSON.stringify(properties) !== JSON.stringify(Object.keys(expected.properties).sort())) throw new Error(`${tool.name} schema properties differ: ${JSON.stringify(properties)}`);
    if (JSON.stringify([...(schema.required ?? [])].sort()) !== JSON.stringify([...expected.required].sort())) throw new Error(`${tool.name} required properties differ: ${JSON.stringify(schema.required ?? [])}`);
    for (const [name, type] of Object.entries(expected.properties)) {
      if (schema.properties[name]?.type !== type) throw new Error(`${tool.name}.${name} type differs: ${String(schema.properties[name]?.type)}`);
    }
    for (const [name, nested] of Object.entries(expected.nested ?? {})) {
      const child = schema.properties[name];
      if (child.additionalProperties !== false || JSON.stringify(Object.keys(child.properties ?? {}).sort()) !== JSON.stringify(Object.keys(nested).sort())) throw new Error(`${tool.name}.${name} nested schema differs`);
      for (const [childName, type] of Object.entries(nested)) if (child.properties[childName]?.type !== type) throw new Error(`${tool.name}.${name}.${childName} type differs`);
    }
    const output = tool.outputSchema;
    if (output?.type !== "object" || output.additionalProperties !== false) throw new Error(`${tool.name} output schema is not a strict object`);
    if (JSON.stringify(Object.keys(output.properties ?? {}).sort()) !== JSON.stringify(expectedOutputProperties[tool.name])) throw new Error(`${tool.name} output schema properties differ`);
    if (JSON.stringify([...(output.required ?? [])].sort()) !== JSON.stringify(["format"])) throw new Error(`${tool.name} output required properties differ`);
  }
}

async function open(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--root", root, "--agent", "mcp-benchmark"],
    cwd: root,
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  const client = new Client({ name: "duo-mcp-benchmark", version: "1.0.0" });
  const started = performance.now();
  await client.connect(transport);
  return { client, transport, initializeMs: performance.now() - started };
}

async function prime(root) {
  const session = await open(root);
  try { await session.client.listTools(); } finally { await session.transport.close(); }
}

async function measure(root, warm) {
  if (warm) await prime(root);
  const latencyMs = {};
  const errors = [];
  let session;
  try {
    session = await open(root);
    latencyMs.initialize = session.initializeMs;
    let started = performance.now();
    const listed = await session.client.listTools();
    latencyMs["tools/list"] = performance.now() - started;
    verifyTools(listed.tools);
    for (const name of expectedNames) {
      started = performance.now();
      try {
        const result = await session.client.callTool({ name, arguments: toolArguments[name] });
        latencyMs[name] = performance.now() - started;
        if (result.isError) errors.push({ stage: name, kind: "tool-error", detail: String(result.content?.[0]?.text ?? "unknown") });
      } catch (error) {
        latencyMs[name] = performance.now() - started;
        errors.push({ stage: name, kind: "client-error", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    errors.push({ stage: "session", kind: "process-error", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await session?.transport.close().catch(() => undefined);
  }
  return { latencyMs, errors };
}

async function scenario(template, temp, name, count, warm) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const roots = Array.from({ length: count }, (_, worker) => path.join(temp, `${name}-${iteration}-${worker}`));
    roots.forEach((root) => copyFixture(template, root));
    samples.push(...await Promise.all(roots.map((root) => measure(root, warm))));
  }
  return { samples: samples.length, latency: summarize(samples), errorCount: samples.reduce((sum, sample) => sum + sample.errors.length, 0), errors: samples.flatMap((sample) => sample.errors) };
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-benchmark-"));
try {
  if (!fs.existsSync(cli)) throw new Error("built CLI not found; run pnpm build first");
  const template = prepareTemplate(temp);
  const scenarios = {};
  for (const [name, count, warm] of [["single-cold", 1, false], ["single-warm", 1, true], ["concurrent-cold", concurrency, false], ["concurrent-warm", concurrency, true]]) {
    scenarios[name] = await scenario(template, temp, name, count, warm);
  }
  const result = {
    format: "duo.mcp-benchmark/1",
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    configuration: { iterations, concurrency, warmDefinition: "one unmeasured initialize and tools/list on the same fixture copy before the measured server start" },
    toolContract: { names: expectedNames, verified: true },
    scenarios,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Object.values(scenarios).some((scenario) => scenario.errorCount > 0)) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
