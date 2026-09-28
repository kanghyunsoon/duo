import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject } from "../cli/support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const FAKE = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("MCP wire stability (T16.1): cancellation, unexpected exceptions, stdout", () => {
  const p = existingProject(temps);
  let marker = "";
  beforeAll(() => {
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "duo-marker-")), "marker.txt");
    temps.push(path.dirname(marker));
  });
  const lines = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : []);

  it("client cancellation aborts the operation's AbortSignal, ends that request, and the server keeps serving", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [FAKE, p.root, marker], stderr: "pipe", env: getDefaultEnvironment() });
    const errors: Error[] = [];
    const client = new Client({ name: "t161", version: "0" });
    await client.connect(transport);
    client.onerror = (e) => errors.push(e);
    try {
      const controller = new AbortController();
      const pending = client.callTool({ name: "duo_get_context", arguments: { task: "anything" } }, { signal: controller.signal });
      await until(() => lines().includes("started"));
      controller.abort();
      await expect(pending).rejects.toThrow();
      await until(() => lines().includes("aborted")); // the server-side signal fired (notifications/cancelled)
      const status = await client.callTool({ name: "duo_get_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toMatchObject({ format: "duo.status/1", initialized: true });
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("an unexpected exception is a tool failure for that call only; duo_get_status right after succeeds", async () => {
    let stderr = "";
    const transport = new StdioClientTransport({ command: process.execPath, args: [FAKE, p.root, marker], stderr: "pipe", env: getDefaultEnvironment() });
    transport.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const client = new Client({ name: "t161", version: "0" });
    await client.connect(transport);
    try {
      const failed = await client.callTool({ name: "duo_trace", arguments: { node: "src/scheduler.ts" } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("MCP_INTERNAL_ERROR");
      const status = await client.callTool({ name: "duo_get_status", arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toMatchObject({ format: "duo.status/1" });
      expect(stderr).toContain("INTERNAL duo_trace: boom");
    } finally {
      await client.close();
    }
  });

  it("stdout carries only JSON-RPC frames, also around an exception and stderr logging (raw wire)", async () => {
    const child = spawn(process.execPath, [FAKE, p.root, marker], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    await until(() => out.includes("\"id\":1"));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "duo_trace", arguments: { node: "x" } } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "duo_get_status", arguments: {} } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "duo_trace", arguments: { node: "x", extra: 1 } } });
    await until(() => ["\"id\":2", "\"id\":3", "\"id\":4"].every((s) => out.includes(s)));
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
    const frames = out.split("\n").filter((l) => l !== "");
    for (const f of frames) expect(JSON.parse(f)).toMatchObject({ jsonrpc: "2.0" }); // every stdout line is a frame
    const byId = new Map(frames.map((f) => JSON.parse(f) as { id?: number; result?: { isError?: boolean; instructions?: string } }).map((m) => [m.id, m] as const));
    expect(byId.get(1)?.result?.instructions).toContain("duo_get_context");
    expect(byId.get(2)?.result?.isError).toBe(true);
    expect(byId.get(3)?.result?.isError).toBeFalsy();
    expect(byId.get(4)?.result?.isError).toBe(true);
    expect(err).toContain("boom");
  });
});
