import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expectedOutputProperties, expectedSchemas } from "./mcp-contract.mjs";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(workspace, "apps", "cli", "dist", "main.js");
const fixture = path.join(workspace, "fixtures", "context", "app");
const smoke = process.argv.includes("--smoke");
const serverScript = process.env.DUO_MCP_BENCHMARK_SERVER_SCRIPT;
const pidFile = process.env.DUO_MCP_BENCHMARK_PID_FILE;
/**
 * Test hook (#126): record every server process this benchmark started, from the client side, so a regression test
 * can check that none is left running. Recording here does not depend on how fast the server process boots.
 */
function recordPid(transport) {
  if (pidFile && transport.pid !== null && transport.pid !== undefined) fs.appendFileSync(pidFile, `${transport.pid}\n`);
}
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number.parseInt(process.argv[index + 1] ?? "", 10);
};
/** Invalid arguments are a benchmark failure (exit 2), never a stage error (exit 1). */
const usage = (message) => {
  process.stderr.write(`mcp-benchmark: ${message}\n`);
  process.exit(2);
};
const iterations = option("--iterations", smoke ? 1 : 10);
const concurrency = option("--concurrency", smoke ? 2 : 8);
const timeoutMs = option("--timeout-ms", 30_000);
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
  usage("--iterations, --concurrency, and --timeout-ms must be positive integers");
}
const SCENARIOS = [["single-cold", 1, false], ["single-warm", 1, true], ["concurrent-cold", concurrency, false], ["concurrent-warm", concurrency, true]];
// --scenario <name> runs one scenario (the timeout regression tests use it); the default measures all four.
const scenarioIndex = process.argv.indexOf("--scenario");
const only = scenarioIndex < 0 ? undefined : process.argv[scenarioIndex + 1];
if (only !== undefined && !SCENARIOS.some(([name]) => name === only)) {
  usage(`--scenario must be one of ${SCENARIOS.map(([name]) => name).join(", ")}; got ${JSON.stringify(only ?? "")}`);
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
const expectedNames = Object.keys(toolArguments).sort();

function command(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function prepareTemplate(temp) {
  const root = path.join(temp, "template");
  // A fake server (DUO_MCP_BENCHMARK_SERVER_SCRIPT) never reads the repository, so it gets an empty directory and no Git.
  if (serverScript) {
    fs.mkdirSync(root);
    return root;
  }
  fs.cpSync(fixture, root, { recursive: true });
  command("git", ["init", "-q"], root);
  command("git", ["config", "user.email", "benchmark@invalid.local"], root);
  command("git", ["config", "user.name", "MCP Benchmark"], root);
  command("git", ["add", "-A"], root);
  command("git", ["commit", "-qm", "fixture"], root);
  if (!serverScript) command(process.execPath, [cli, "index"], root);
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

/**
 * Close a server and make sure its process is gone. The SDK's close() sends SIGTERM and then SIGKILL without waiting
 * for the kill, so a benchmark that exits right after a timeout could leave the server running for a moment (#126).
 */
async function closeServer(transport) {
  const pid = transport.pid;
  await transport.close().catch(() => undefined);
  if (pid === null || pid === undefined) return;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive() && waited < 3_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

async function open(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverScript ? [serverScript] : [cli, "mcp", "--root", root, "--agent", "mcp-benchmark"],
    cwd: root,
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      ...(serverScript ? {
        DUO_MCP_BENCHMARK_FAKE_MODE: process.env.DUO_MCP_BENCHMARK_FAKE_MODE ?? "",
        DUO_MCP_BENCHMARK_PID_FILE: process.env.DUO_MCP_BENCHMARK_PID_FILE ?? "",
      } : {}),
    },
  });
  const client = new Client({ name: "duo-mcp-benchmark", version: "1.0.0" });
  const started = performance.now();
  try {
    await client.connect(transport, { timeout: timeoutMs });
    recordPid(transport);
    return { client, transport, initializeMs: performance.now() - started };
  } catch (error) {
    recordPid(transport);
    await closeServer(transport);
    throw error;
  }
}

async function prime(root) {
  const session = await open(root);
  try { await session.client.listTools(undefined, { timeout: timeoutMs }); } finally { await closeServer(session.transport); }
}

function errorEntry(stage, error) {
  return {
    stage,
    kind: error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout ? "timeout" : "client-error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

async function measure(root, warm) {
  const latencyMs = {};
  const errors = [];
  if (warm) {
    try { await prime(root); } catch (error) { errors.push(errorEntry("warmup", error)); }
  }
  let session;
  try {
    try {
      session = await open(root);
    } catch (error) {
      errors.push(errorEntry("initialize", error));
      return { latencyMs, errors };
    }
    latencyMs.initialize = session.initializeMs;
    let started = performance.now();
    let listed;
    try {
      listed = await session.client.listTools(undefined, { timeout: timeoutMs });
    } catch (error) {
      latencyMs["tools/list"] = performance.now() - started;
      errors.push(errorEntry("tools/list", error));
      return { latencyMs, errors };
    }
    latencyMs["tools/list"] = performance.now() - started;
    verifyTools(listed.tools);
    for (const name of expectedNames) {
      started = performance.now();
      try {
        const result = await session.client.callTool({ name, arguments: toolArguments[name] }, { timeout: timeoutMs });
        latencyMs[name] = performance.now() - started;
        if (result.isError) errors.push({ stage: name, kind: "tool-error", detail: String(result.content?.[0]?.text ?? "unknown") });
      } catch (error) {
        latencyMs[name] = performance.now() - started;
        errors.push(errorEntry(name, error));
      }
    }
  } catch (error) {
    errors.push({ stage: "session", kind: "process-error", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    if (session) await closeServer(session.transport);
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

// Exit codes: 0 every stage answered, 1 the report lists stage errors (timeouts, tool or client errors),
// 2 the benchmark itself failed before it could report (no JSON on stdout; the reason is on stderr).
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-mcp-benchmark-"));
try {
  if (!serverScript && !fs.existsSync(cli)) throw new Error("built CLI not found; run pnpm build first");
  const template = prepareTemplate(temp);
  const scenarios = {};
  for (const [name, count, warm] of SCENARIOS) {
    if (only !== undefined && name !== only) continue;
    scenarios[name] = await scenario(template, temp, name, count, warm);
  }
  const result = {
    format: "duo.mcp-benchmark/1",
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    configuration: { iterations, concurrency, timeoutMs, ...(only === undefined ? {} : { scenario: only }), warmDefinition: "one unmeasured initialize and tools/list on the same fixture copy before the measured server start" },
    toolContract: { names: expectedNames, verified: true },
    scenarios,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (Object.values(scenarios).some((scenario) => scenario.errorCount > 0)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`mcp-benchmark: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
