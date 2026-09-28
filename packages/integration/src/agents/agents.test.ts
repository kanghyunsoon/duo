import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BRIDGE_MARKERS, bridgeLines, inspectBridge } from "./bridge.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { CODEX_MARKERS, codexAdapter } from "./codex.js";
import { planAgentIntegration } from "./integration.js";
import { checkLauncher, NPX_LAUNCHER, PATH_LAUNCHER } from "./launcher.js";
import { findBlock, removeBlock, upsertBlock } from "./managed-block.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-agents-"))); temps.push(d); return d; };

const block = ["<!-- duo-director:begin -->", "hello", "<!-- duo-director:end -->"];

describe("managed block", () => {
  it("append then remove restores the file byte for byte (LF, CRLF, no trailing newline is normalized once)", () => {
    for (const human of ["# Rules\n\nUse tabs.\n", "# Rules\r\n\r\nUse tabs.\r\n", "one line\n"]) {
      const withBlock = upsertBlock(human, block, BRIDGE_MARKERS);
      expect(withBlock.startsWith(human)).toBe(true);
      expect(withBlock.includes("\r\n")).toBe(human.includes("\r\n"));
      expect(removeBlock(withBlock, BRIDGE_MARKERS)).toBe(human);
    }
    expect(upsertBlock(undefined, block, BRIDGE_MARKERS)).toBe(block.join("\n") + "\n");
  });

  it("replaces only the block and keeps text after it", () => {
    const text = "top\n\n" + block.join("\n") + "\nbottom\n";
    const next = upsertBlock(text, [block[0] as string, "changed", block[2] as string], BRIDGE_MARKERS);
    expect(next).toBe("top\n\n<!-- duo-director:begin -->\nchanged\n<!-- duo-director:end -->\nbottom\n");
  });

  it("reports malformed markers: a begin without an end, two blocks, reversed", () => {
    for (const t of ["a\n<!-- duo-director:begin -->\n", "<!-- duo-director:end -->\n", block.join("\n") + "\n" + block.join("\n"), "<!-- duo-director:end -->\nx\n<!-- duo-director:begin -->\n"]) {
      expect(findBlock(t, BRIDGE_MARKERS).kind).toBe("malformed");
    }
    expect(() => upsertBlock("<!-- duo-director:begin -->\n", block, BRIDGE_MARKERS)).toThrow();
  });
});

describe("bridge contract (what the agent is told)", () => {
  const lines = bridgeLines("duoctl");
  const text = lines.join("\n");
  it("says: status before substantial work, context before implementation, index and review after changes, pending ≠ confirmed, proposal only", () => {
    expect(text).toMatch(/Before substantial work: call duo_get_status/u);
    expect(text).toMatch(/then call duo_get_context/u);
    expect(text).toMatch(/After meaningful code changes: run `duoctl index`, then call duo_review_changes/u);
    expect(text).toMatch(/Pending proposals are not confirmed/u);
    expect(text).toMatch(/ASK/u);
    expect(text).toMatch(/Never bypass BLOCK by editing Project Truth/u);
    expect(text).toMatch(/duo_propose_decision\. You cannot confirm or reject decisions/u);
  });
  it("is short and has no repository context (AC-017-05)", () => {
    expect(lines.length - 2).toBeLessThanOrEqual(10);
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//u);
    expect(bridgeLines("npx --no-install duoctl").join("\n")).toContain("`npx --no-install duoctl index`");
    expect(inspectBridge(undefined, lines)).toBe("absent");
    expect(inspectBridge(`x\n\n${text}\n`, lines)).toBe("current");
    expect(inspectBridge(`${BRIDGE_MARKERS.begin}\nold\n${BRIDGE_MARKERS.end}\n`, lines)).toBe("outdated");
  });
});

describe("Codex adapter (.codex/config.toml)", () => {
  const planned = codexAdapter.plannedEntry(PATH_LAUNCHER);
  const human = "# comment\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"o\" # inline\n";
  it("appends a managed block, keeps human TOML byte-identical, is idempotent, and removes cleanly", () => {
    expect(codexAdapter.inspect(human, planned).status).toBe("not-configured");
    const next = codexAdapter.write(human, planned) as string;
    expect(next.startsWith(human)).toBe(true);
    expect(codexAdapter.inspect(next, planned)).toMatchObject({ status: "already-configured", managed: true });
    expect(codexAdapter.write(next, planned)).toBe(next);
    expect(codexAdapter.remove(next)).toBe(human);
    expect(codexAdapter.remove(codexAdapter.write(undefined, planned) as string)).toBeNull(); // DUO-only file → delete
    expect(planned.args).toEqual(["mcp", "--root-from", "git-cwd", "--agent", "codex"]);
  });
  it("classifies collisions: same entry by hand, a DUO launch outside the block, another command, invalid TOML, bad markers", () => {
    const byHand = `${human}\n[mcp_servers.duo-director]\ncommand = "duoctl"\nargs = ["mcp", "--root-from", "git-cwd", "--agent", "codex"]\n`;
    expect(codexAdapter.inspect(byHand, planned)).toMatchObject({ status: "already-configured", managed: false });
    expect(codexAdapter.inspect(`[mcp_servers.duo-director]\ncommand = "duoctl"\nargs = ["mcp", "--root", "/abs/repo"]\n`, planned)).toMatchObject({ status: "compatible-different-format", managed: false });
    expect(codexAdapter.inspect(`[mcp_servers.duo-director]\ncommand = "node"\nargs = ["server.js"]\n`, planned).status).toBe("conflict");
    expect(codexAdapter.inspect("[mcp_servers\nbroken", planned).status).toBe("conflict");
    expect(codexAdapter.inspect(`${CODEX_MARKERS.begin}\n`, planned).status).toBe("conflict");
    // A layout where a table cannot be appended (inline mcp_servers) is not merged.
    expect(codexAdapter.write("mcp_servers = { other = { command = \"o\" } }\n", planned)).toBeUndefined();
  });
});

describe("Claude Code adapter (.mcp.json)", () => {
  const planned = claudeCodeAdapter.plannedEntry(PATH_LAUNCHER);
  it("sets only mcpServers.duo-director with the file's indent; replaces an older DUO launch; refuses another command", () => {
    const human = JSON.stringify({ mcpServers: { other: { command: "o", args: [] } }, x: 1 }, null, "\t") + "\n";
    const next = claudeCodeAdapter.write(human, planned) as string;
    expect(next).toContain('\t"mcpServers"');
    expect(JSON.parse(next)).toEqual({ mcpServers: { other: { command: "o", args: [] }, "duo-director": { type: "stdio", ...planned } }, x: 1 });
    expect(claudeCodeAdapter.inspect(next, planned).status).toBe("already-configured");
    expect(claudeCodeAdapter.remove(next)).toBe(human);
    const older = JSON.stringify({ mcpServers: { "duo-director": { command: "duoctl", args: ["mcp", "--root", "/abs"] } } });
    expect(claudeCodeAdapter.inspect(older, planned)).toMatchObject({ status: "compatible-different-format", managed: true });
    expect(claudeCodeAdapter.inspect(JSON.stringify({ mcpServers: { "duo-director": { command: "python", args: ["x.py"] } } }), planned).status).toBe("conflict");
    expect(claudeCodeAdapter.remove(JSON.stringify({ mcpServers: { "duo-director": { command: "python", args: [] } } }))).toBeUndefined();
    expect(claudeCodeAdapter.inspect("{ not json", planned).status).toBe("conflict");
    expect(claudeCodeAdapter.inspect("[]", planned).status).toBe("conflict");
    expect(planned.args).toEqual(["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"]);
  });
});

describe("launcher and plan", () => {
  it("accepts only a bare command on PATH (or an absolute path, with a warning); refuses relative paths and shadowing files", () => {
    const root = tmp();
    const bin = tmp();
    const exe = process.platform === "win32" ? "duoctl.cmd" : "duoctl";
    fs.writeFileSync(path.join(bin, exe), "x", { mode: 0o755 });
    const host = { env: { PATH: bin, PATHEXT: ".CMD;.EXE" }, platform: process.platform };
    expect(checkLauncher(root, PATH_LAUNCHER, host)).toMatchObject({ available: true, resolved: path.join(bin, exe) });
    expect(checkLauncher(root, PATH_LAUNCHER, { env: { PATH: "" }, platform: process.platform }).available).toBe(false);
    expect(checkLauncher(root, { kind: "custom", command: "./bin/duoctl", argsPrefix: [] }, host).diagnostics[0]?.code).toBe("AGENT_LAUNCHER_UNAVAILABLE");
    expect(checkLauncher(root, { kind: "custom", command: path.join(bin, exe), argsPrefix: [] }, host).warnings[0]).toMatch(/absolute path/u);
    expect(checkLauncher(root, NPX_LAUNCHER, { env: { PATH: "" }, platform: process.platform }).available).toBe(false);
    fs.writeFileSync(path.join(root, "duoctl.cmd"), "echo hijack");
    expect(checkLauncher(root, PATH_LAUNCHER, host).diagnostics.map((d) => d.code)).toEqual(["AGENT_INTEGRATION_CONFLICT"]);
  });

  it("planning writes nothing and refuses a project that is not initialized", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "human\n");
    const before = fs.readdirSync(root, { recursive: true });
    const plan = planAgentIntegration(root, "codex", { host: { env: { PATH: "" }, platform: process.platform } });
    expect(plan.applicable).toBe(false);
    expect(plan.blockers.map((d) => d.code)).toEqual(expect.arrayContaining(["AGENT_NOT_INITIALIZED", "AGENT_LAUNCHER_UNAVAILABLE"]));
    expect(plan).toMatchObject({ willCreate: [".codex/config.toml"], willModify: ["AGENTS.md"] });
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
  });
});
