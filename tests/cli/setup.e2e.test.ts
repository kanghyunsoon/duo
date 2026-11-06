/**
 * Built-CLI subprocess E2E journey for `duoctl setup` (#3, Jira S15P31A106-254).
 *
 * Covers the acceptance criteria in docs/roadmap/0.4.0-t183-one-command-setup.md §10 across Windows, Ubuntu, and macOS:
 *   O1 — Zero-write refusals (missing confirmation in non-interactive mode, pre-write agent config conflicts)
 *   O2 — One-command full setup (Project Truth, SQLite index, adoption baseline, Codex + Claude Code MCP verification,
 *        non-destructive human file preservation, trust/approval boundary, and immediate `context`/`review` readiness)
 *   O3 — Idempotent rerun (`unchanged` with no `--yes` and zero file diffs) and stale-index incremental refresh
 *   O4 — Post-confirmation MCP verification failure (`resume` contract, preserved Truth, and recovery on rerun)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { GRAPH_DB_FILE_PATH } from "@duo-director/graph";
import { claudeCodeAdapter, codexAdapter } from "@duo-director/integration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctlBin, envWithPath, stringEnv } from "../install/support.js";
import { duoctl, existingProject, snapshot, type Project } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

let bin = "";
let env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  bin = duoctlBin(temps);
  env = envWithPath([bin]);
});

const CODEX_HUMAN = "# Team Codex settings (human)\napproval_policy = \"on-request\"\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other-server\"\nargs = [\"--flag\"] # keep this comment\n";
const AGENTS_HUMAN = "# Team rules\n\nUse tabs. Run the unit tests before pushing.\n";
const MCP_HUMAN = JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other-server", args: [] } }, extra: true }, null, 4) + "\n";
const CLAUDE_HUMAN = "# Notes for Claude\n\nPrefer small commits.\n";

const read = (p: Project, f: string) => fs.readFileSync(path.join(p.root, f), "utf8");
const exists = (p: Project, f: string) => fs.existsSync(path.join(p.root, f));
const setup = (p: Project, args: string[], stdin = "", customEnv: NodeJS.ProcessEnv = env) =>
  duoctl(p.root, ["setup", ...args, "--non-interactive", "--json"], stdin, customEnv);

async function spawnConfigured(entry: { command: string; args: readonly string[] }, cwd: string, extra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: entry.command, args: [...entry.args], cwd, stderr: "pipe", env: { ...stringEnv(env), ...extra } });
  const client = new Client({ name: "setup-e2e-agent-sim", version: "0" });
  await client.connect(transport);
  return client;
}

describe("duoctl setup E2E: O1 zero-write refusals and pre-write conflict gate (#3, S15P31A106-254)", () => {
  it("O1-a: non-interactive setup without --yes exits 6 (confirmation-required) and writes 0 files", () => {
    const p = existingProject(temps);
    p.write(".codex/config.toml", CODEX_HUMAN);
    p.write("AGENTS.md", AGENTS_HUMAN);
    p.git("add", "-A");
    p.git("commit", "-qm", "human codex config");

    const before = snapshot(p.root);
    const r = setup(p, ["--agent", "codex"]);

    expect(r.code).toBe(6);
    const out = r.json().result;
    expect(out.status).toBe("confirmation-required");
    expect(out.applied).toBe(false);
    expect(out.plan.state).toBe("not-initialized");
    expect(out.plan.agents).toEqual([
      expect.objectContaining({
        id: "codex",
        noop: false,
        willCreate: [],
        willModify: [".codex/config.toml", "AGENTS.md"],
      }),
    ]);
    expect(exists(p, ".duo-project")).toBe(false);
    expect(snapshot(p.root)).toEqual(before);
  });

  it("O1-b: conflicting agent MCP configuration blocks the entire setup before Truth or index is created", () => {
    const p = existingProject(temps);
    p.write(".codex/config.toml", `${CODEX_HUMAN}\n[mcp_servers.duo-director]\ncommand = "someone-else"\n`);
    p.write(".mcp.json", JSON.stringify({ mcpServers: { "duo-director": { command: "someone-else", args: ["serve"] } } }, null, 2) + "\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "conflicting duo-director entries");

    const before = snapshot(p.root);
    const r = setup(p, ["--agent", "codex", "--agent", "claude-code", "--yes"]);

    expect(r.code).toBe(6);
    const payload = r.json();
    expect(payload.result).toMatchObject({
      status: "blocked",
      applied: false,
      steps: {
        repository: { status: "ok" },
        truth: { status: "skipped" },
        index: { status: "skipped" },
        baseline: { status: "skipped" },
        agents: {
          codex: { status: "action-required" },
          "claude-code": { status: "action-required" },
        },
      },
    });
    expect(payload.diagnostics.map((d: { code: string }) => d.code)).toContain("AGENT_INTEGRATION_CONFLICT");
    expect(exists(p, ".duo-project")).toBe(false);
    expect(snapshot(p.root)).toEqual(before);
  });
});

describe("duoctl setup E2E: O2 one-command full setup, immediate CLI/MCP readiness, and O3 idempotent rerun (#3, S15P31A106-254)", () => {
  let p: Project;

  beforeAll(() => {
    p = existingProject(temps);
    p.write(".codex/config.toml", CODEX_HUMAN);
    p.write("AGENTS.md", AGENTS_HUMAN);
    p.write(".mcp.json", MCP_HUMAN);
    p.write("CLAUDE.md", CLAUDE_HUMAN);
    p.git("add", "-A");
    p.git("commit", "-qm", "existing human agent configs");
  });

  it("O2-a: one command creates Truth, builds index, captures baseline, connects Codex + Claude Code, preserves user files, and respects trust/approval boundaries", () => {
    const answers = JSON.stringify([
      { question: "current_milestone", title: "M1 — Core scheduler" },
      { question: "critical_constraints", statements: ["Keep domain steps deterministic."] },
    ]);
    const r = setup(p, ["--agent", "codex", "--agent", "claude-code", "--answers", "-", "--yes"], answers);

    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = r.json().result;
    expect(out.status).toBe("set-up");
    expect(out.applied).toBe(true);
    expect(out.steps).toMatchObject({
      repository: { status: "ok" },
      truth: { status: "ok" },
      index: { status: "ok" },
      baseline: { status: "ok" },
      agents: {
        codex: { status: "ok" },
        "claude-code": { status: "ok" },
      },
    });

    // Project Truth, SQLite graph index, and adoption baseline exist.
    expect(out.baseline.path).toMatch(/^\.duo-project\/reviews\/adoption-[0-9a-f]+\.json$/u);
    for (const rel of [
      ".duo-project/project.yaml",
      ".duo-project/.gitignore",
      ".duo-project/intent/vision.md",
      ".duo-project/intent/constraints.yaml",
      ".duo-project/milestones/M1.yaml",
      out.baseline.path as string,
      GRAPH_DB_FILE_PATH,
    ]) {
      expect(exists(p, rel), `expected ${rel} to exist`).toBe(true);
    }

    // Both agents passed live MCP child-process verification with a current index.
    expect(out.agents.codex.verify).toMatchObject({
      ok: true,
      server: { name: "duo-director", index: "current" },
    });
    expect(out.agents["claude-code"].verify).toMatchObject({
      ok: true,
      server: { name: "duo-director", index: "current" },
    });
    expect(out.doctor.overall).toBe("ready");
    expect(out.remaining).toEqual([
      expect.stringContaining("Codex: trust"),
      expect.stringContaining("Claude Code: run claude"),
    ]);

    // Human files stay intact at the top and receive exactly one managed DUO entry/block; no absolute paths or trust bypasses.
    const toml = read(p, ".codex/config.toml");
    expect(toml.startsWith(CODEX_HUMAN)).toBe(true);
    expect(toml.split("# duo-director:begin")).toHaveLength(2);
    expect(toml).not.toContain("trust_level");
    expect(toml).not.toContain(p.root);

    const agentsMd = read(p, "AGENTS.md");
    expect(agentsMd.startsWith(AGENTS_HUMAN)).toBe(true);
    expect(agentsMd.split("<!-- duo-director:begin -->")).toHaveLength(2);

    const mcpJsonText = read(p, ".mcp.json");
    const mcpJson = JSON.parse(mcpJsonText);
    expect(mcpJson.extra).toBe(true);
    expect(mcpJson.mcpServers.other).toEqual({ type: "stdio", command: "other-server", args: [] });
    expect(mcpJson.mcpServers["duo-director"]).toEqual({
      type: "stdio",
      command: "duoctl",
      args: ["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"],
    });

    const claudeMd = read(p, "CLAUDE.md");
    expect(claudeMd.startsWith(CLAUDE_HUMAN)).toBe(true);
    expect(claudeMd.split("<!-- duo-director:begin -->")).toHaveLength(2);
    expect(exists(p, ".claude")).toBe(false);
  });

  it("O2-b: duoctl context, duoctl review, and live MCP sessions work immediately after setup without running duoctl index", async () => {
    const ctx = duoctl(p.root, ["context", "Scheduler.next", "--json"], "", env);
    expect(ctx.code, ctx.stdout + ctx.stderr).toBe(0);
    expect(ctx.json().result.context.packet.format).toBe("duo.context-packet/1");

    const rev = duoctl(p.root, ["review", "--json"], "", env);
    expect(rev.code, rev.stdout + rev.stderr).toBe(0);
    expect(rev.json().result).toMatchObject({ status: "ready", verdict: "PASS" });

    const codexEntry = codexAdapter.readEntry(read(p, ".codex/config.toml"));
    const claudeEntry = claudeCodeAdapter.readEntry(read(p, ".mcp.json"));
    const c1 = await spawnConfigured(codexEntry as { command: string; args: string[] }, path.join(p.root, "src", "steps"));
    const c2 = await spawnConfigured(claudeEntry as { command: string; args: string[] }, path.join(p.root, "src"), { CLAUDE_PROJECT_DIR: p.root });
    try {
      for (const client of [c1, c2]) {
        const status = await client.callTool({ name: "duo_get_status", arguments: {} });
        expect(status.structuredContent).toMatchObject({
          format: "duo.status/1",
          initialized: true,
          project: { name: "orbit-tasks" },
          index: { status: "current" },
        });
      }
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  it("O3-a: rerunning duoctl setup on an already configured repository needs no --yes, reports unchanged, and writes 0 bytes", () => {
    const before = snapshot(p.root);
    const r = setup(p, ["--agent", "codex", "--agent", "claude-code"]);

    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json().result).toMatchObject({
      status: "unchanged",
      applied: false,
      steps: {
        repository: { status: "ok" },
        truth: { status: "existing" },
        index: { status: "existing" },
        baseline: { status: "existing" },
        agents: {
          codex: { status: "ok" },
          "claude-code": { status: "ok" },
        },
      },
      doctor: { overall: "ready" },
    });
    expect(snapshot(p.root)).toEqual(before);
  });

  it("O3-b: rerunning duoctl setup after a source edit refreshes the stale index incrementally without --yes", () => {
    p.edit("src/scheduler.ts", "% 7", "% 6");
    try {
      const r = setup(p, []);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.json().result).toMatchObject({
        status: "unchanged",
        applied: true,
        steps: {
          truth: { status: "existing" },
          index: { status: "ok" },
          baseline: { status: "existing" },
        },
        index: { mode: "incremental" },
      });
    } finally {
      p.git("checkout", "--", "src/scheduler.ts");
    }
  });
});

describe("duoctl setup E2E: O4 post-confirmation MCP verification failure and resume recovery (#3, S15P31A106-254)", () => {
  it("O4: preserves Project Truth and names the resume command when MCP verification fails, then converges on rerun with a healthy PATH", () => {
    const p = existingProject(temps);
    const brokenBin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-setup-broken-bin-")));
    temps.push(brokenBin);
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(brokenBin, "duoctl.cmd"), "@echo off\r\nexit /b 3\r\n");
    }
    fs.writeFileSync(path.join(brokenBin, "duoctl"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const brokenEnv = envWithPath([brokenBin]);

    const failed = setup(p, ["--agent", "codex", "--yes"], "", brokenEnv);
    expect(failed.code).toBe(1);
    const failedPayload = failed.json();
    expect(failedPayload.result).toMatchObject({
      status: "failed",
      applied: true,
      resume: "duoctl setup --agent codex",
      steps: {
        repository: { status: "ok" },
        truth: { status: "ok" },
        index: { status: "ok" },
        baseline: { status: "ok" },
        agents: { codex: { status: "failed" } },
      },
    });
    expect(failedPayload.diagnostics.map((d: { code: string }) => d.code)).toContain("AGENT_VERIFY_FAILED");
    expect(exists(p, ".duo-project/project.yaml")).toBe(true);
    expect(exists(p, failedPayload.result.baseline.path as string)).toBe(true);
    expect(read(p, ".codex/config.toml")).toContain("[mcp_servers.duo-director]");

    const truthBeforeResume = read(p, ".duo-project/project.yaml");

    // Rerun the exact resume command (without --yes, since config files were already written and only verification remains) using healthy PATH.
    const resumed = setup(p, ["--agent", "codex"], "", env);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.json().result).toMatchObject({
      status: "unchanged",
      applied: false,
      steps: {
        truth: { status: "existing" },
        index: { status: "existing" },
        baseline: { status: "existing" },
        agents: { codex: { status: "ok" } },
      },
      agents: {
        codex: {
          verify: { ok: true, server: { name: "duo-director", index: "current" } },
        },
      },
      doctor: { overall: "ready" },
    });
    expect(read(p, ".duo-project/project.yaml")).toBe(truthBeforeResume);
  });
});
