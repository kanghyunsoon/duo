import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXPECTED_MCP_TOOLS } from "@duo-director/integration";
import { VERSION } from "../../apps/cli/src/version.js";
import { duoctl, existingProject, type Project } from "../cli/support.js";
import { envWithPath } from "./support.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A real MCP subprocess with configurable initialize version and tool list; no model or DUO index. */
function server(bin: string, version: string, tools: readonly string[]) {
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "server.cjs");
  fs.writeFileSync(script, `const lines = require('node:readline').createInterface({ input: process.stdin });
const tools = ${JSON.stringify(tools)};
lines.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = {protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'duo-director',version:${JSON.stringify(version)}}};
  else if (m.method === 'tools/list') result = {tools:tools.map(name=>({name,inputSchema:{type:'object'}}))};
  else if (m.method === 'tools/call') result = {content:[],structuredContent:{index:{status:'current'},baseline:{status:'current'}}};
  else return;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`);
  const executable = path.join(bin, process.platform === "win32" ? "duoctl.cmd" : "duoctl");
  fs.writeFileSync(executable, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return executable;
}

for (const agent of ["codex", "claude-code"] as const) {
  describe(`${agent}: built install launcher verification (#40)`, () => {
    let p: Project, local: string, global: string, resolved: string;
    beforeAll(() => {
      p = existingProject(temps);
      expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
      local = path.join(p.root, "node_modules", ".bin");
      global = path.join(p.root, "global-bin");
      server(local, VERSION, EXPECTED_MCP_TOOLS);
      resolved = server(global, "0.2.0", EXPECTED_MCP_TOOLS);
    });
    const args = ["install", agent, "--yes", "--non-interactive"];
    function env(dirs = [local, global], keepPath = true) {
      const inherited = envWithPath(dirs, keepPath);
      // Vitest exposes uppercase Windows env keys; native spawn must receive just one npm_command key.
      const clean = Object.fromEntries(Object.entries(inherited).filter(([k]) => k.toLowerCase() !== "npm_command"));
      return { ...clean, npm_command: "exec" };
    }

    it("launches the older global server, warns in JSON/en/ko and retains exit 0", () => {
      const json = duoctl(p.root, [...args, "--json"], "", env());
      expect(json.code).toBe(0);
      expect(json.json().result.verify).toMatchObject({
        ok: true, launcher: { resolved, version: "0.2.0" },
        warnings: [{ code: "launcher-version-mismatch", cliVersion: VERSION, serverVersion: "0.2.0", resolved }],
      });
      expect(json.json().result.verify.warnings[0].nextActions).toHaveLength(2);
      for (const locale of ["en", "ko"]) {
        const human = duoctl(p.root, [...args, "--locale", locale], "", env());
        expect(human.code).toBe(0);
        for (const text of ["launcher-version-mismatch", VERSION, "0.2.0", resolved, `duoctl install ${agent} --launcher npx`]) expect(human.stdout).toContain(text);
        expect(human.stdout).toContain(locale === "ko" ? `${resolved}의 DUO` : `DUO installation at ${resolved}`);
      }
    });

    it("keeps tool-list failure as exit 1 even when the versions differ", () => {
      server(global, "0.2.0", EXPECTED_MCP_TOOLS.slice(1));
      const result = duoctl(p.root, [...args, "--json"], "", env());
      expect(result.code).toBe(1);
      expect(result.json().result.verify).toMatchObject({ ok: false, warnings: [{ code: "launcher-version-mismatch" }] });
      expect(result.json().result.verify.checks).toContainEqual(expect.objectContaining({ name: "mcp-launch", ok: false }));
    });

    it("does not warn for matching or empty server versions", () => {
      for (const version of [VERSION, ""]) {
        server(global, version, EXPECTED_MCP_TOOLS);
        const result = duoctl(p.root, [...args, "--json"], "", env());
        expect(result.code).toBe(0);
        expect(result.json().result.verify.warnings).toBeUndefined();
      }
    });

    it("blocks local-only PATH before writing and never prints Verify: ok", () => {
      const missing = env([local], false);
      const result = duoctl(p.root, [...args, "--json"], "", missing);
      expect(result.code).toBe(6);
      expect(result.json().result.plan).toMatchObject({ applicable: false, requirements: { duoctlAvailable: false } });
      expect(result.json().result.verify).toBeUndefined();
      const human = duoctl(p.root, args, "", missing);
      expect(human.code).toBe(6);
      const output = human.stdout + human.stderr;
      expect(output).toContain("--launcher npx");
      expect(output).not.toContain("Verify: ok");
    });

    // #40-5: doctor reaches the same verification as install, with the CLI version passed in (40-4).
    const checkId = agent === "codex" ? "agent.codex" : "agent.claude_code";
    const doctor = (extra: string[] = []) => duoctl(p.root, ["doctor", ...extra], "", env());
    const agentCheck = (run: ReturnType<typeof doctor>) => run.json().result.checks.find((c: { id: string }) => c.id === checkId);

    it("doctor: an older global server is a version-mismatch warning with both versions and the npx step; exit 0", () => {
      server(global, "0.2.0", EXPECTED_MCP_TOOLS);
      const json = doctor(["--json"]);
      expect(json.code).toBe(0);
      expect(agentCheck(json)).toMatchObject({
        status: "warning", reason: "version-mismatch", facts: { cliVersion: VERSION, serverVersion: "0.2.0", resolved },
        actions: [{ id: "align-launcher", commands: [`duoctl install ${agent} --launcher npx`] }],
      });
      expect(json.json().result.next).toContainEqual(expect.objectContaining({ id: "align-launcher" }));
      for (const locale of ["en", "ko"]) {
        const human = doctor(["--locale", locale]);
        expect(human.code).toBe(0);
        for (const text of [VERSION, "0.2.0", resolved, `duoctl install ${agent} --launcher npx`]) expect(human.stdout).toContain(text);
      }
    });

    it("doctor: a tool-list failure stays an error (exit 6) despite the version difference; a matching version is verified", () => {
      server(global, "0.2.0", EXPECTED_MCP_TOOLS.slice(1));
      const failed = doctor(["--json"]);
      expect(failed.code).toBe(6);
      expect(agentCheck(failed)).toMatchObject({ status: "error", reason: "mcp-tools-mismatch", facts: { version: "0.2.0" } });
      server(global, VERSION, EXPECTED_MCP_TOOLS);
      expect(agentCheck(doctor(["--json"]))).toMatchObject({ status: "ok", reason: "verified" });
    });

    it("remove still works when the effective PATH has no launcher, and leaves no DUO entry", () => {
      const removed = duoctl(p.root, ["install", "remove", agent, "--yes", "--json"], "", env([local], false));
      expect(removed.code).toBe(0);
      const target = path.join(p.root, agent === "codex" ? ".codex/config.toml" : ".mcp.json");
      expect(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "").not.toContain("duo-director");
    });
  });
}
