import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { claudeCodeAdapter, codexAdapter } from "@duo-director/integration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject, snapshot, type Project } from "../cli/support.js";
import { duoctlBin, envWithPath, stringEnv } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

let bin = "";
let env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  bin = duoctlBin(temps);
  env = envWithPath([bin]);
});

const CODEX_HUMAN = "# Team Codex settings (human)\napproval_policy = \"on-request\"\n\n[mcp_servers.other]\ncommand = \"other-server\"\nargs = [\"--flag\"] # keep this comment\n";
const AGENTS_HUMAN = "# Team rules\n\nUse tabs. Run the unit tests before pushing.\n";
const MCP_HUMAN = JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other-server", args: [] } }, extra: true }, null, 4) + "\n";
const CLAUDE_HUMAN = "# Notes for Claude\n\nPrefer small commits.\n";

/** Files and hashes without runtime/metrics.jsonl (install appends its metric like every metered command). */
const stable = (p: Project) => snapshot(p.root).filter(([f]) => !f.endsWith("metrics.jsonl"));
const read = (p: Project, f: string) => fs.readFileSync(path.join(p.root, f), "utf8");
const exists = (p: Project, f: string) => fs.existsSync(path.join(p.root, f));
const install = (p: Project, args: string[]) => duoctl(p.root, ["install", ...args, "--non-interactive", "--json"], "", env);

/** Starts the configured launch like the agent would: executable + args, a session directory, the agent's environment. */
async function spawnConfigured(entry: { command: string; args: readonly string[] }, cwd: string, extra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: entry.command, args: [...entry.args], cwd, stderr: "pipe", env: { ...stringEnv(env), ...extra } });
  const client = new Client({ name: "agent-sim", version: "0" });
  await client.connect(transport);
  return client;
}

function initialized(): Project {
  const p = existingProject(temps);
  expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
  return p;
}

describe("duoctl install codex on an existing project with human configuration (TASK-017)", () => {
  let p: Project;
  beforeAll(() => {
    p = initialized();
    p.write(".codex/config.toml", CODEX_HUMAN);
    p.write("AGENTS.md", AGENTS_HUMAN);
  });

  it("without --yes a non-interactive install only plans: exit 6, write 0, the plan lists the files", () => {
    const before = stable(p);
    const r = install(p, ["codex"]);
    expect(r.code).toBe(6);
    const plan = r.json().result.plan;
    expect(r.json().result.status).toBe("confirmation-required");
    expect(plan).toMatchObject({
      agent: "codex", operation: "install", applicable: true, willCreate: [], willModify: [".codex/config.toml", "AGENTS.md"],
      mcp: { status: "not-configured", action: "modify", planned: { command: "duoctl", args: ["mcp", "--root-from", "git-cwd", "--agent", "codex"] } },
      bridge: { status: "absent", action: "modify" }, requirements: { duoctlAvailable: true, projectTrustRequired: true, approvalRequired: false },
    });
    expect(stable(p)).toEqual(before);
  });

  it("--yes applies: human TOML and AGENTS.md are kept byte for byte, DUO adds one managed block each, verify spawns the server", () => {
    const r = install(p, ["codex", "--yes"]);
    expect(r.code).toBe(0);
    const out = r.json().result;
    expect(out.status).toBe("installed");
    expect(out.verify).toMatchObject({ ok: true, server: { name: "duo-director", index: "current" } });
    expect(out.verify.server.tools).toHaveLength(9);
    const toml = read(p, ".codex/config.toml");
    expect(toml.startsWith(CODEX_HUMAN)).toBe(true);
    expect(toml.split("# duo-director:begin")).toHaveLength(2);
    expect(codexAdapter.readEntry(toml)).toEqual({ command: "duoctl", args: ["mcp", "--root-from", "git-cwd", "--agent", "codex"] });
    expect(toml).not.toContain(p.root);
    const agents = read(p, "AGENTS.md");
    expect(agents.startsWith(AGENTS_HUMAN)).toBe(true);
    expect(agents.split("<!-- duo-director:begin -->")).toHaveLength(2);
    expect(out.apply.backups.length).toBe(2);
  });

  it("a second install is unchanged: no duplicate entry, block or instruction", () => {
    const before = [read(p, ".codex/config.toml"), read(p, "AGENTS.md")];
    const r = install(p, ["codex", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json().result).toMatchObject({ status: "unchanged", plan: { noop: true, mcp: { status: "already-configured" }, bridge: { status: "current" } } });
    expect([read(p, ".codex/config.toml"), read(p, "AGENTS.md")]).toEqual(before);
  });

  it("the configured command starts DUO from a subdirectory session (--root-from git-cwd): tools/list, status, context", async () => {
    const entry = codexAdapter.readEntry(read(p, ".codex/config.toml"));
    const client = await spawnConfigured(entry as { command: string; args: string[] }, path.join(p.root, "src", "steps"));
    try {
      expect((await client.listTools()).tools).toHaveLength(9);
      const status = await client.callTool({ name: "duo_get_status", arguments: {} });
      expect(status.structuredContent).toMatchObject({ format: "duo.status/1", initialized: true, project: { name: "orbit-tasks" }, index: { status: "current" } });
      const ctx = await client.callTool({ name: "duo_get_context", arguments: { task: "Scheduler.next" } });
      expect(ctx.structuredContent).toMatchObject({ status: "ready", context: { packet: { format: "duo.context-packet/1" } } });
    } finally {
      await client.close();
    }
  });

  it("a stale index does not fail install; verify reports it with the next action", () => {
    p.edit("src/scheduler.ts", "% 7", "% 6");
    const r = install(p, ["codex", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json().result.verify.server.index).toBe("stale");
    expect(r.json().result.verify.nextActions).toContain("duoctl index");
    p.git("checkout", "--", "src/scheduler.ts");
  });

  it("status is read-only and distinguishes configured from not-configured", () => {
    const before = stable(p);
    const r = duoctl(p.root, ["install", "status", "--json"], "", env);
    expect(r.code).toBe(0);
    expect(r.json().result.agents.map((a: { agent: string; status: string }) => [a.agent, a.status])).toEqual([["codex", "configured"], ["claude-code", "not-configured"]]);
    expect(stable(p)).toEqual(before);
  });

  it("remove takes out only the DUO entry and block: the human files are restored byte for byte, .duo-project stays", () => {
    const r = install(p, ["remove", "codex", "--yes"]);
    expect(r.code).toBe(0);
    expect(read(p, ".codex/config.toml")).toBe(CODEX_HUMAN);
    expect(read(p, "AGENTS.md")).toBe(AGENTS_HUMAN);
    expect(exists(p, ".duo-project/project.yaml")).toBe(true);
    expect(install(p, ["remove", "codex", "--yes"]).json().result.plan.noop).toBe(true);
  });
});

describe("duoctl install claude-code: .mcp.json merge, CLAUDE.md, collisions (TASK-017)", () => {
  let p: Project;
  beforeAll(() => {
    p = initialized();
    p.write(".mcp.json", MCP_HUMAN);
    p.write("CLAUDE.md", CLAUDE_HUMAN);
  });

  it("merges only mcpServers.duo-director (other servers, keys and the 4-space indent stay) and appends the bridge block", async () => {
    const r = install(p, ["claude-code", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json().result.plan.requirements).toMatchObject({ approvalRequired: true, projectTrustRequired: false });
    expect(r.json().result.verify.ok).toBe(true);
    const text = read(p, ".mcp.json");
    const json = JSON.parse(text);
    expect(json.extra).toBe(true);
    expect(json.mcpServers.other).toEqual({ type: "stdio", command: "other-server", args: [] });
    expect(json.mcpServers["duo-director"]).toEqual({ type: "stdio", command: "duoctl", args: ["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"] });
    expect(text).toMatch(/^ {4}"mcpServers"/mu);
    expect(read(p, "CLAUDE.md").startsWith(CLAUDE_HUMAN)).toBe(true);
    expect(install(p, ["claude-code", "--yes"]).json().result.status).toBe("unchanged");
    // Claude Code sets CLAUDE_PROJECT_DIR for the server; the session may be a subdirectory.
    const client = await spawnConfigured(claudeCodeAdapter.readEntry(text) as { command: string; args: string[] }, path.join(p.root, "src"), { CLAUDE_PROJECT_DIR: p.root });
    try {
      expect((await client.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true, index: { status: "current" } });
    } finally {
      await client.close();
    }
  });

  it("a duo-director entry that starts another command is a conflict: --yes does not overwrite it", () => {
    install(p, ["remove", "claude-code", "--yes"]);
    expect(read(p, ".mcp.json")).toBe(MCP_HUMAN); // re-serialized with the file's own indent: byte-identical here
    const taken = JSON.stringify({ mcpServers: { "duo-director": { command: "someone-else", args: ["serve"] } } }, null, 2) + "\n";
    p.write(".mcp.json", taken);
    const before = stable(p);
    const r = install(p, ["claude-code", "--yes"]);
    expect(r.code).toBe(6);
    expect(r.json().result.plan).toMatchObject({ applicable: false, mcp: { status: "conflict", action: "blocked" } });
    expect(r.json().diagnostics.map((d: { code: string }) => d.code)).toContain("AGENT_INTEGRATION_CONFLICT");
    expect(stable(p)).toEqual(before);
  });

  it("malformed bridge markers are a conflict; nothing is written", () => {
    p.write(".mcp.json", MCP_HUMAN);
    p.write("CLAUDE.md", CLAUDE_HUMAN + "\n<!-- duo-director:begin -->\nhalf a block\n");
    const before = stable(p);
    const r = install(p, ["claude-code", "--yes"]);
    expect(r.code).toBe(6);
    expect(r.json().result.plan.bridge).toMatchObject({ status: "malformed", action: "blocked" });
    expect(stable(p)).toEqual(before);
  });
});

describe("install preconditions and clone portability (TASK-017)", () => {
  it("before duoctl init: NOT_INITIALIZED (exit 5), no configuration or bridge, no init", () => {
    const p = existingProject(temps);
    const before = stable(p);
    const r = install(p, ["codex", "--yes"]);
    expect(r.code).toBe(5);
    expect(r.json().diagnostics.map((d: { code: string }) => d.code)).toContain("AGENT_NOT_INITIALIZED");
    expect(stable(p)).toEqual(before);
  });

  it("an unavailable launcher or a repository file that could shadow it blocks the install", () => {
    const p = initialized();
    const noDuoctl = duoctl(p.root, ["install", "codex", "--yes", "--non-interactive", "--json"], "", envWithPath([path.dirname(process.execPath)], false));
    expect(noDuoctl.code).toBe(6);
    expect(noDuoctl.json().diagnostics.map((d: { code: string }) => d.code)).toContain("AGENT_LAUNCHER_UNAVAILABLE");
    p.write(process.platform === "win32" ? "duoctl.cmd" : "duoctl", "echo hijack\n");
    const shadowed = install(p, ["codex", "--yes"]);
    expect(shadowed.code).toBe(6);
    expect(JSON.stringify(shadowed.json().diagnostics)).toContain("could be started instead");
    expect(exists(p, ".codex/config.toml")).toBe(false);
  });

  it("committed integration files carry no absolute path; a clone at another path starts its own DUO", async () => {
    const p = initialized();
    expect(install(p, ["codex", "--yes"]).code).toBe(0);
    expect(install(p, ["claude-code", "--yes"]).code).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "DUO and agent integration");
    const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-clone-")));
    temps.push(clone);
    const moved = path.join(clone, "moved-repo");
    execFileSync("git", ["clone", "-q", p.root, moved], { windowsHide: true });
    for (const f of [".codex/config.toml", ".mcp.json", "AGENTS.md", "CLAUDE.md"]) {
      const text = fs.readFileSync(path.join(moved, f), "utf8");
      expect(text).not.toContain(p.root);
      expect(text).not.toContain(p.root.replaceAll("\\", "/"));
      expect(text).not.toContain(path.dirname(p.root));
    }
    // The clone has Truth but no regenerable graph: its own server reports index missing (the original is current).
    const codexEntry = codexAdapter.readEntry(fs.readFileSync(path.join(moved, ".codex/config.toml"), "utf8"));
    const c1 = await spawnConfigured(codexEntry as { command: string; args: string[] }, path.join(moved, "src"));
    const claudeEntry = claudeCodeAdapter.readEntry(fs.readFileSync(path.join(moved, ".mcp.json"), "utf8"));
    const c2 = await spawnConfigured(claudeEntry as { command: string; args: string[] }, moved, { CLAUDE_PROJECT_DIR: moved });
    try {
      for (const c of [c1, c2]) {
        expect((await c.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true, project: { name: "orbit-tasks" }, index: { status: "missing" } });
      }
    } finally {
      await c1.close();
      await c2.close();
    }
    expect(duoctl(moved, ["index", "--json"], "", env).code).toBe(0);
    expect(duoctl(moved, ["install", "status", "--json"], "", env).json().result.agents.map((a: { status: string }) => a.status)).toEqual(["configured", "configured"]);
  });
});
