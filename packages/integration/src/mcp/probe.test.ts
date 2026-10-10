/**
 * C254 (T52): probeMcpLaunch against small stdio servers, with short injected timeouts (never the 30 s default).
 * A server that answers late but within the timeout succeeds; one that answers after the timeout, or never, fails with
 * the timeout in the error, and the spawned process does not outlive the probe in either case. After a timeout the
 * probe returns once the SDK's close has ended the server (stdin end, then SIGTERM and SIGKILL after 2 s each).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probeMcpLaunch } from "./probe.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

/**
 * A line-delimited JSON-RPC MCP server: it writes its pid, waits DELAY_MS before answering initialize (HANG=1: never
 * answers) and answers tools/list and tools/call. A hanging server ignores stdin closing, so only the probe's cleanup ends it.
 */
const SERVER = String.raw`
const fs = require("node:fs");
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
const delay = Number(process.env.DELAY_MS ?? "0"), hang = process.env.HANG === "1";
if (hang) setInterval(() => undefined, 1000);
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const m = JSON.parse(line);
    if (hang || m.id === undefined) continue;
    if (m.method === "initialize") setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow-test", version: "1" } } }), delay);
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: { ok: true } } });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no method" } });
  }
});
`;

function server(): { readonly script: string; readonly dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-probe-"));
  temps.push(dir);
  const script = path.join(dir, "server.cjs");
  fs.writeFileSync(script, SERVER);
  return { script, dir };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid the server wrote, then whether it is gone within a short grace period after the probe returned. */
async function exited(pidFile: string): Promise<boolean> {
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

async function run(env: Record<string, string>, timeoutMs: number) {
  const { script, dir } = server();
  const pidFile = path.join(dir, "pid");
  const t0 = performance.now();
  const result = await probeMcpLaunch({ command: process.execPath, args: [script], cwd: dir, env: { ...env, PID_FILE: pidFile }, timeoutMs });
  return { result, ms: performance.now() - t0, pidFile };
}

describe("probeMcpLaunch timeout and cleanup (C254)", () => {
  it("a server that answers late but within the timeout succeeds, and its process ends", async () => {
    const { result, pidFile } = await run({ DELAY_MS: "200" }, 5000);
    expect(result).toMatchObject({ ok: true, serverName: "slow-test", tools: [], status: { ok: true } });
    expect(await exited(pidFile)).toBe(true);
  });

  it("the same server answering after the timeout fails with the timeout, and its process ends", async () => {
    const { result, ms, pidFile } = await run({ DELAY_MS: "1500" }, 100);
    expect(result).toMatchObject({ ok: false, error: "no answer within 100 ms" });
    expect(ms).toBeLessThan(100 + 4000 + 2000);
    expect(await exited(pidFile)).toBe(true);
  });

  it("a server that never answers and ignores stdin closing is ended by the probe after the timeout", async () => {
    const { result, ms, pidFile } = await run({ HANG: "1" }, 300);
    expect(result).toMatchObject({ ok: false, error: "no answer within 300 ms" });
    // The timeout decides the failure; the return then waits for the SDK's close (stdin end, 2 s, SIGTERM, 2 s, SIGKILL).
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(300 + 4000 + 2000);
    expect(await exited(pidFile)).toBe(true);
  });
});
