import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMcpLaunch } from "../mcp/probe.js";
import { bridgeLines } from "./bridge.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { EXPECTED_MCP_TOOLS, planAgentIntegration, verifyAgentIntegration } from "./integration.js";
import { effectiveLauncherHost, NPX_LAUNCHER, PATH_LAUNCHER, type HostEnvironment } from "./launcher.js";
import type { DuoLauncher } from "./types.js";

vi.mock("../mcp/probe.js", () => ({ probeMcpLaunch: vi.fn() }));
const probe = vi.mocked(probeMcpLaunch);
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
beforeEach(() => probe.mockReset());

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-launch-verify-")));
  temps.push(root);
  const local = path.join(root, "node_modules", ".bin"), global = path.join(root, "global-bin");
  const exe = process.platform === "win32" ? "duoctl.cmd" : "duoctl";
  for (const dir of [local, global]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, exe), "fixture", { mode: 0o755 });
  }
  fs.mkdirSync(path.join(root, ".duo-project"));
  fs.writeFileSync(path.join(root, ".duo-project", "project.yaml"), "");
  const host: HostEnvironment = { platform: process.platform, env: { PATH: [local, global].join(path.delimiter), PATHEXT: ".CMD;.EXE", npm_command: "exec" } };
  return { root, local, global, exe, host };
}

describe("measured runner activation and PATH boundaries", () => {
  const evidence = JSON.parse(fs.readFileSync(new URL("../../../../docs/roadmap/issue-40-runner-evidence.json", import.meta.url), "utf8")) as {
    runs: { runner: string; npm_command: string | null; npm_execpath: string | null; npm_lifecycle_event: string | null }[];
  };
  for (const measured of evidence.runs) {
    it(`${measured.runner}: honors the recorded markers and declared coverage`, () => {
      const env: Record<string, string> = { PATH: "/project/node_modules/.bin:/global" };
      for (const key of ["npm_command", "npm_execpath", "npm_lifecycle_event"] as const) {
        const value = measured[key];
        if (value !== null) env[key] = value;
      }
      const result = effectiveLauncherHost(PATH_LAUNCHER, { platform: "linux", env });
      expect(result.env.PATH).toBe(measured.runner === "pnpm-dlx" ? env.PATH : "/global");
    });
  }
  it("normalizes terminal segments only, keeps order and PATHEXT, supports Windows Path casing without mutation", () => {
    const env = { Path: "C:\\A\\NODE_MODULES\\.BIN\\;C:\\first;C:/cache/node_modules/./.bin;C:\\node_modules\\.bin-extra;C:\\last", PATHEXT: ".CMD;.EXE", NPM_COMMAND: "exec" };
    const result = effectiveLauncherHost(PATH_LAUNCHER, { platform: "win32", env });
    expect(result.env.Path).toBe("C:\\first;C:\\node_modules\\.bin-extra;C:\\last");
    expect(result.env.PATHEXT).toBe(env.PATHEXT);
    expect(env.Path).toContain("NODE_MODULES");
    const duplicate = effectiveLauncherHost(PATH_LAUNCHER, { platform: "win32", env: { ...env, PATH: "C:\\wrong\\node_modules\\.bin" } });
    expect(duplicate.env.PATH).toBe(duplicate.env.Path);
  });
  it("keeps POSIX case, removes relative injected bins, and does not filter ordinary/direct or custom launches", () => {
    const host: HostEnvironment = { platform: "linux", env: { PATH: "./node_modules/.bin:/a/NODE_MODULES/.bin:/a/node_modules/.bin/:/b", npm_command: "exec" } };
    expect(effectiveLauncherHost(PATH_LAUNCHER, host).env.PATH).toBe("/a/NODE_MODULES/.bin:/b");
    expect(effectiveLauncherHost(NPX_LAUNCHER, host)).toBe(host);
    expect(effectiveLauncherHost({ kind: "custom", command: "/bin/duoctl", argsPrefix: [] }, host)).toBe(host);
    const direct = { ...host, env: { PATH: host.env.PATH } };
    expect(effectiveLauncherHost(PATH_LAUNCHER, direct)).toBe(direct);
  });
  it("pins documented limits: user-added bins are dropped, unmeasured npm forms and Yarn's own dirs are kept", () => {
    const userBin = "/work/myapp/node_modules/.bin";
    const exec: HostEnvironment = { platform: "linux", env: { PATH: `/project/node_modules/.bin:${userBin}:/global`, npm_command: "exec" } };
    expect(effectiveLauncherHost(PATH_LAUNCHER, exec).env.PATH).toBe("/global");
    for (const npm_command of ["test", "start", "run-script"]) {
      const unmeasured: HostEnvironment = { platform: "linux", env: { PATH: exec.env.PATH as string, npm_command } };
      expect(effectiveLauncherHost(PATH_LAUNCHER, unmeasured)).toBe(unmeasured);
    }
    const yarn: HostEnvironment = { platform: "win32", env: {
      Path: "C:\\T\\yarn--1-0.5;C:\\p\\node_modules\\.bin;C:\\U\\Yarn\\Data\\link\\node_modules\\.bin;C:\\U\\Yarn\\bin;C:\\g",
      npm_execpath: "C:\\tools\\yarn\\bin\\yarn.js", npm_lifecycle_event: "probe",
    } };
    expect(effectiveLauncherHost(PATH_LAUNCHER, yarn).env.Path).toBe("C:\\T\\yarn--1-0.5;C:\\U\\Yarn\\bin;C:\\g");
  });
});

for (const adapter of [codexAdapter, claudeCodeAdapter]) {
  function installed(root: string, launcher: DuoLauncher = PATH_LAUNCHER) {
    fs.mkdirSync(path.dirname(path.join(root, adapter.mcpTarget)), { recursive: true });
    fs.writeFileSync(path.join(root, adapter.mcpTarget), adapter.write(undefined, adapter.plannedEntry(launcher)) as string);
    fs.writeFileSync(path.join(root, adapter.bridgeTarget), bridgeLines([launcher.command, ...launcher.argsPrefix].join(" ")).join("\n") + "\n");
  }
  describe(`${adapter.id}: effective launcher verification (#40)`, () => {
    it("plans and probes the global launcher with the same filtered PATH; config stays portable", async () => {
      const f = fixture();
      installed(f.root);
      probe.mockResolvedValue({ ok: true, serverName: "duo-director", serverVersion: "0.2.0", tools: EXPECTED_MCP_TOOLS, status: null });
      expect(planAgentIntegration(f.root, adapter.id, { host: f.host })).toMatchObject({ applicable: true, mcp: { planned: { command: "duoctl" } } });
      const result = await verifyAgentIntegration(f.root, adapter.id, { host: f.host });
      expect(result).toMatchObject({ ok: true, launcher: { resolved: path.join(f.global, f.exe) } });
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ command: "duoctl", env: expect.objectContaining({ PATH: f.global, PATHEXT: ".CMD;.EXE" }) }));
      expect(f.host.env.PATH).toBe([f.local, f.global].join(path.delimiter));
      expect(fs.readFileSync(path.join(f.root, adapter.mcpTarget), "utf8")).not.toContain(f.root);
    });

    it("canonicalizes Windows PATH keys before the MCP SDK adds inherited defaults", async () => {
      if (process.platform !== "win32") return;
      const f = fixture();
      installed(f.root);
      probe.mockResolvedValue({ ok: true, serverName: "duo-director", serverVersion: "0.3.3", tools: EXPECTED_MCP_TOOLS, status: null });
      await verifyAgentIntegration(f.root, adapter.id, { host: { platform: "win32", env: { Path: f.host.env.PATH, PATHEXT: ".CMD;.EXE", NPM_COMMAND: "exec" } } });
      expect(probe.mock.calls[0]?.[0].env).toMatchObject({ PATH: f.global });
      expect(probe.mock.calls[0]?.[0].env).not.toHaveProperty("Path");
    });

    it("blocks a local-only PATH plan, fails verification and recommends npx without probing", async () => {
      const f = fixture();
      installed(f.root);
      const host = { ...f.host, env: { ...f.host.env, PATH: f.local } };
      const plan = planAgentIntegration(f.root, adapter.id, { host });
      expect(plan.applicable).toBe(false);
      expect(plan.blockers.some((d) => d.message.includes("--launcher npx"))).toBe(true);
      const result = await verifyAgentIntegration(f.root, adapter.id, { host });
      expect(result.ok).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({ name: "launcher", ok: false }));
      expect(result.nextActions).toContain(`duoctl install ${adapter.id} --launcher npx`);
      expect(probe).not.toHaveBeenCalled();
    });

    for (const [cliVersion, serverVersion, mismatch] of [
      [undefined, "0.2.0", false], ["", "0.2.0", false], ["0.3.3", "", false],
      ["0.3.3", "0.3.3", false], ["0.3.3", "0.2.0", true], ["0.3.3", "0.3.3+build", true],
    ] as const) {
      it(`compares exact known non-empty versions: CLI ${cliVersion}, server ${serverVersion}`, async () => {
        const f = fixture();
        installed(f.root);
        probe.mockResolvedValue({ ok: true, serverName: "duo-director", serverVersion, tools: EXPECTED_MCP_TOOLS, status: null });
        const result = await verifyAgentIntegration(f.root, adapter.id, { host: f.host, ...(cliVersion === undefined ? {} : { cliVersion }) });
        expect(result.ok).toBe(true);
        if (mismatch) {
          expect(result.warnings).toEqual([{
            code: "launcher-version-mismatch", cliVersion, serverVersion, resolved: path.join(f.global, f.exe),
            nextActions: [`Update the DUO installation at ${path.join(f.global, f.exe)} to ${cliVersion}.`, `duoctl install ${adapter.id} --launcher npx`],
          }]);
        } else expect(result.warnings).toBeUndefined();
      });
    }
    it("does not mask tool-list/server-name failures, or fabricate a mismatch when probing fails or is skipped", async () => {
      const f = fixture();
      installed(f.root);
      const options = { host: f.host, cliVersion: "0.3.3" };
      for (const [name, tools] of [["duo-director", []], ["wrong-server", EXPECTED_MCP_TOOLS]] as const) {
        probe.mockResolvedValue({ ok: true, serverName: name, serverVersion: "0.2.0", tools, status: null });
        const result = await verifyAgentIntegration(f.root, adapter.id, options);
        expect(result.ok).toBe(false);
        expect(result.warnings?.[0]?.code).toBe("launcher-version-mismatch");
      }
      probe.mockResolvedValue({ ok: false, error: "offline", stderr: "" });
      const failed = await verifyAgentIntegration(f.root, adapter.id, options);
      expect(failed.ok).toBe(false);
      expect(failed.warnings).toBeUndefined();
      probe.mockClear();
      expect((await verifyAgentIntegration(f.root, adapter.id, { ...options, launch: false })).warnings).toBeUndefined();
      expect(probe).not.toHaveBeenCalled();
    });

    it("leaves an explicit npx launch on its original PATH", async () => {
      const f = fixture();
      fs.writeFileSync(path.join(f.global, process.platform === "win32" ? "npx.cmd" : "npx"), "fixture", { mode: 0o755 });
      installed(f.root, NPX_LAUNCHER);
      probe.mockResolvedValue({ ok: true, serverName: "duo-director", serverVersion: "0.3.3", tools: EXPECTED_MCP_TOOLS, status: null });
      expect((await verifyAgentIntegration(f.root, adapter.id, { host: f.host })).ok).toBe(true);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ command: "npx", env: expect.objectContaining({ PATH: f.host.env.PATH }) }));
    });
  });
}
