/**
 * T17.1: the packed @duo-director/cli, installed like a user would, runs DUO on an existing repository
 * without this repository: init → index → status → context → review → install codex|claude-code →
 * the generated MCP configuration started from the installed duoctl. Global (temporary npm prefix) and
 * project-local (npx --no-install) installs. Nothing falls back to the workspace build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existingProject, type Project } from "../cli/support.js";
import { codexEntry, dirSize, installedPackages, IS_WIN, isolatedEnv, npm, packReport, recordMetric, REPO, runOnPath, which, type PackReport } from "./support.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const tmp = (prefix: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); temps.push(d); return d; };

let pack: PackReport;
let prefix = "";
let bin = "";
let pkgDir = "";
let env: Record<string, string> = {};

const TSX = "export function Badge(props: { label: string }) {\n  return <span className=\"badge\">{props.label}</span>;\n}\n";
const JS = "export function legacyTotal(items) {\n  return items.reduce((n, i) => n + i, 0);\n}\n";

function project(): Project {
  const p = existingProject(temps);
  p.write("src/badge.tsx", TSX);
  p.write("src/legacy.js", JS);
  p.git("add", "-A");
  p.git("commit", "-qm", "ui and legacy");
  return p;
}

const duoctl = (p: Project | string, args: string[], input = "") => runOnPath("duoctl", args, typeof p === "string" ? p : p.root, env, input);

async function spawnConfigured(entry: { command: string; args: readonly string[] }, cwd: string, e: Record<string, string>) {
  const transport = new StdioClientTransport({ command: entry.command, args: [...entry.args], cwd, stderr: "pipe", env: e });
  const client = new Client({ name: "agent-sim", version: "0" });
  await client.connect(transport);
  return client;
}

beforeAll(() => {
  pack = packReport();
  prefix = tmp("duo-prefix-");
  const r = npm(["install", "-g", "--prefix", prefix, pack.tarball, "--no-audit", "--no-fund", "--loglevel=error"], prefix, isolatedEnv([]));
  if (r.status !== 0) throw new Error(`npm install -g failed: ${r.stderr}`);
  bin = IS_WIN ? prefix : path.join(prefix, "bin");
  pkgDir = path.join(prefix, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli");
  env = isolatedEnv([bin]);
});

describe("the packed artifact (npm pack is the oracle)", () => {
  it("holds only the allowlisted files: the executable, the bundle, the grammar WASM and licenses, README, package.json", () => {
    const files = pack.files.map((f) => f.path);
    for (const f of files) expect(f, f).toMatch(/^(package\.json|README\.md|dist\/duoctl\.js|dist\/cli-[A-Z0-9]+\.js|dist\/grammars\/(tree-sitter-(typescript|tsx|javascript)\.wasm|LICENSE-tree-sitter-(typescript|javascript)))$/u);
    expect(files).toEqual(expect.arrayContaining(["dist/duoctl.js", "dist/grammars/tree-sitter-typescript.wasm", "dist/grammars/tree-sitter-tsx.wasm", "dist/grammars/tree-sitter-javascript.wasm"]));
    const forbidden = /(^|\/)(\.env|\.worklog|fixtures|coverage|\.duo-project|node_modules|tmp)(\/|$)|credentials|\.pem$|\.key$|id_rsa|\.p12$|metrics\.jsonl|\.map$|\.test\.|\.tgz$/iu;
    expect(files.filter((f) => forbidden.test(f))).toEqual([]);
  });

  it("package.json: public name and bin, Node engine, exact runtime dependencies only, no scripts, no workspace links", () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO, ".dist", "cli-package", "package.json"), "utf8"));
    expect(m).toMatchObject({ name: "@duo-director/cli", bin: { duoctl: "dist/duoctl.js" }, engines: { node: ">=24.15.0" }, type: "module", files: ["dist"] });
    expect(m.version).toMatch(/^0\.\d+\.\d+$/u);
    expect(m.version).toBe(JSON.parse(fs.readFileSync(path.join(REPO, "apps", "cli", "package.json"), "utf8")).version);
    expect(m.scripts).toBeUndefined();
    expect(m.devDependencies).toBeUndefined();
    expect(m.private).toBeUndefined();
    for (const [n, v] of Object.entries(m.dependencies as Record<string, string>)) {
      expect(v, n).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(n).not.toMatch(/^@duo-director\/|^tree-sitter-(typescript|javascript)$/u);
    }
    for (const f of ["dist/duoctl.js", ...pack.files.map((x) => x.path).filter((x) => /^dist\/cli-/u.test(x))]) {
      const text = fs.readFileSync(path.join(REPO, ".dist", "cli-package", f), "utf8");
      expect(text).not.toMatch(/from\s*["']@duo-director\//u);
      expect(text).not.toContain(REPO);
    }
    expect(fs.readFileSync(path.join(REPO, ".dist", "cli-package", "dist", "duoctl.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("packing again gives the same files, bytes and metadata (deterministic)", () => {
    const out = tmp("duo-pack2-");
    execFileSync(process.execPath, [path.join(REPO, "scripts", "pack-cli.mjs"), "--out", out], { cwd: REPO, windowsHide: true, stdio: "pipe" });
    const again = packReport(out);
    expect(again.files).toEqual(pack.files);
    expect(again.sha256).toEqual(pack.sha256);
    expect(again.dependencies).toEqual(pack.dependencies);
    expect(again.integrity).toBe(pack.integrity);
    recordMetric("pack", { tarballBytes: pack.size, unpackedBytes: pack.unpackedSize, files: pack.files, integrity: pack.integrity });
  });
});

describe("global install (temporary npm prefix)", () => {
  it("installs without native builds or install scripts; the installed files are the packed ones", () => {
    const pkgs = installedPackages(path.dirname(path.dirname(pkgDir)));
    const scripted = pkgs.filter((p) => ["preinstall", "install", "postinstall"].some((s) => s in p.scripts) || p.gyp);
    expect(scripted).toEqual([]);
    expect(pkgs.map((p) => p.name)).not.toEqual(expect.arrayContaining(["node-gyp", "node-gyp-build", "tree-sitter-typescript", "tree-sitter-javascript"]));
    for (const [f, sha] of Object.entries(pack.sha256)) expect(createHash("sha256").update(fs.readFileSync(path.join(pkgDir, f))).digest("hex"), f).toBe(sha);
    recordMetric("globalInstall", { packages: pkgs.length, bytesOnDisk: dirSize(IS_WIN ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules")), names: pkgs.map((x) => `${x.name}@${x.version}`).sort() });
  });

  it("duoctl resolves to the installed shim, reports the package version and schema versions, and cannot see the workspace", () => {
    const found = which("duoctl", env.PATH ?? "");
    expect(found?.startsWith(bin)).toBe(true);
    expect(which("pnpm", env.PATH ?? "")).toBeUndefined();
    const cwd = tmp("duo-cwd-");
    const v = duoctl(cwd, ["--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe(`duoctl ${pack.version}`);
    const j = duoctl(cwd, ["--version", "--json"]).json();
    expect(j).toMatchObject({ name: "duoctl", version: pack.version, graphSchemaVersion: expect.any(Number), projectSchemaVersions: [1] });
    // The internal packages exist only inside the bundle.
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "import('@duo-director/core').then(() => process.exit(0), () => process.exit(3))"], { cwd: pkgDir, env, windowsHide: true });
    expect(probe.status).toBe(3);
  });

  describe("an existing repository driven only by the installed duoctl", () => {
    let p: Project;
    beforeAll(() => { p = project(); });

    it("init, index, status, context, review; TypeScript, TSX and JavaScript parse with the packaged grammars; llm calls 0", () => {
      const init = duoctl(p, ["init", "--non-interactive", "--answers", "-", "--json"], "[]");
      expect(init.code, init.stderr).toBe(0);
      expect(init.json().result.steps).toMatchObject({ truth: { status: "ok" }, index: { status: "ok" }, baseline: { status: "ok" } });
      p.edit("src/scheduler.ts", "% 7", "% 5");
      expect(duoctl(p, ["index", "--json"]).json().result).toMatchObject({ mode: "incremental" });
      expect(duoctl(p, ["status", "--json"]).json().result).toMatchObject({ initialized: true, index: { status: "current" }, llm: "disabled" });
      const ctx = duoctl(p, ["context", "Scheduler.next", "--json"]);
      expect(ctx.json().result).toMatchObject({ status: "ready", context: { packet: { format: "duo.context-packet/1" } } });
      const rv = duoctl(p, ["review", "--json"]).json().result;
      expect(rv).toMatchObject({ status: "ready", metrics: { llmCalls: 0 } });
      expect(rv.diff.files.map((f: { path: string }) => f.path)).toContain("src/scheduler.ts");
      for (const [node, file] of [["Badge", "src/badge.tsx"], ["legacyTotal", "src/legacy.js"], ["Scheduler.next", "src/scheduler.ts"]]) {
        const tr = duoctl(p, ["trace", node as string, "--json"]);
        expect(tr.code, `${node}: ${tr.stderr}`).toBe(0);
        expect(tr.json().result.node).toMatchObject({ type: "symbol", path: file });
      }
    });

    it("install codex: the generated configuration starts the installed duoctl (initialize, tools/list, status, context); verify reports its provenance", async () => {
      const r = duoctl(p, ["install", "codex", "--non-interactive", "--yes", "--json"]);
      expect(r.code, r.stderr).toBe(0);
      const verify = r.json().result.verify;
      expect(verify).toMatchObject({ ok: true, launcher: { kind: "path", command: "duoctl", version: pack.version } });
      expect(verify.launcher.resolved.startsWith(bin)).toBe(true);
      const entry = codexEntry(fs.readFileSync(path.join(p.root, ".codex", "config.toml"), "utf8"));
      expect(entry).toEqual({ command: "duoctl", args: ["mcp", "--root-from", "git-cwd", "--agent", "codex"] });
      const client = await spawnConfigured(entry, path.join(p.root, "src"), env);
      try {
        expect(client.getServerVersion()).toMatchObject({ name: "duo-director", version: pack.version });
        expect((await client.listTools()).tools).toHaveLength(9);
        expect((await client.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true, index: { status: "current" } });
        expect((await client.callTool({ name: "duo_get_context", arguments: { task: "Badge" } })).structuredContent).toMatchObject({ status: "ready" });
      } finally {
        await client.close();
      }
    });

    it("install claude-code: the generated command starts the installed duoctl with CLAUDE_PROJECT_DIR", async () => {
      const r = duoctl(p, ["install", "claude-code", "--non-interactive", "--yes", "--json"]);
      expect(r.code, r.stderr).toBe(0);
      const entry = JSON.parse(fs.readFileSync(path.join(p.root, ".mcp.json"), "utf8")).mcpServers["duo-director"];
      expect(entry.command).toBe("duoctl");
      const client = await spawnConfigured(entry, path.join(p.root, "src"), { ...env, CLAUDE_PROJECT_DIR: p.root });
      try {
        expect((await client.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true });
      } finally {
        await client.close();
      }
    });

    it("a clone at another path works with the installed duoctl and no DUO source anywhere", async () => {
      p.git("add", "-A");
      p.git("commit", "-qm", "DUO and agent integration");
      const moved = path.join(tmp("duo-clone-"), "moved");
      execFileSync("git", ["clone", "-q", p.root, moved], { windowsHide: true });
      const toml = fs.readFileSync(path.join(moved, ".codex", "config.toml"), "utf8");
      expect(toml).not.toContain(p.root);
      expect(toml).not.toContain(REPO);
      const client = await spawnConfigured(codexEntry(toml), path.join(moved, "src"), env);
      try {
        expect((await client.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true, index: { status: "missing" } });
      } finally {
        await client.close();
      }
      expect(duoctl(moved, ["index", "--json"]).code).toBe(0);
      expect(duoctl(moved, ["install", "status", "--json"]).json().result.agents.map((a: { status: string }) => a.status)).toEqual(["configured", "configured"]);
    });
  });
});

describe("project-local install (npx --no-install duoctl)", () => {
  it("with @duo-director/cli installed in the project, npx --no-install duoctl runs it and the npx launcher is configured and verified", async () => {
    const p = project();
    const local = isolatedEnv([]); // no global duoctl on PATH
    const inst = npm(["install", "-D", pack.tarball, "--no-audit", "--no-fund", "--loglevel=error"], p.root, local);
    expect(inst.status, inst.stderr).toBe(0);
    p.git("add", "-A");
    p.git("commit", "-qm", "add duoctl as a devDependency");
    const npx = (args: string[], input = "") => runOnPath("npx", ["--no-install", "duoctl", ...args], p.root, local, input);
    const bins = fs.readdirSync(path.join(p.root, "node_modules", ".bin"));
    expect(bins.filter((b) => b.startsWith("duoctl"))).not.toEqual([]);
    const version = npx(["--version"]);
    expect(version.stdout.trim(), `code ${version.code} · stderr: ${version.stderr} · bins: ${bins.join(",")} · npx: ${which("npx", local.PATH ?? "")}`).toBe(`duoctl ${pack.version}`);
    expect(npx(["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const r = npx(["install", "codex", "--launcher", "npx", "--non-interactive", "--yes", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json().result.verify).toMatchObject({ ok: true, launcher: { kind: "npx", command: "npx", argsPrefix: ["--no-install", "duoctl"], version: pack.version } });
    const entry = codexEntry(fs.readFileSync(path.join(p.root, ".codex", "config.toml"), "utf8"));
    expect(entry.command).toBe("npx");
    const client = await spawnConfigured(entry, path.join(p.root, "src"), local);
    try {
      expect((await client.listTools()).tools).toHaveLength(9);
      expect((await client.callTool({ name: "duo_get_status", arguments: {} })).structuredContent).toMatchObject({ initialized: true });
    } finally {
      await client.close();
    }
  });

  it("without the project-local package the npx launcher is unavailable: nothing is written, and npx --no-install does not download", () => {
    const p = project();
    expect(duoctl(p, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const r = duoctl(p, ["install", "codex", "--launcher", "npx", "--non-interactive", "--yes", "--json"]);
    expect(r.code).toBe(6);
    expect(JSON.stringify(r.json().diagnostics)).toContain("AGENT_LAUNCHER_UNAVAILABLE");
    expect(fs.existsSync(path.join(p.root, ".codex"))).toBe(false);
    const npx = runOnPath("npx", ["--no-install", "duoctl", "--version"], p.root, isolatedEnv([]));
    expect(npx.code).not.toBe(0);
    expect(fs.existsSync(path.join(p.root, "node_modules"))).toBe(false);
  });
});

describe("distribution failure messages (last: they damage the temporary install)", () => {
  it("a missing grammar asset names the asset and says to reinstall the package (never a monorepo build)", () => {
    const p = project();
    fs.rmSync(path.join(pkgDir, "dist", "grammars", "tree-sitter-tsx.wasm"));
    const r = duoctl(p, ["init", "--non-interactive", "--answers", "-", "--json"], "[]");
    expect(r.code).not.toBe(0);
    const text = r.stdout + r.stderr;
    expect(text).toContain("ANALYZER_INIT_FAILED");
    expect(text).toContain("tree-sitter-tsx.wasm");
    expect(text).toContain("reinstall the @duo-director/cli package");
    expect(text).not.toMatch(/pnpm/u);
  });

  it("a missing runtime dependency is an incomplete installation, reported before anything runs", () => {
    const yaml = [path.join(pkgDir, "node_modules", "yaml"), path.join(path.dirname(path.dirname(pkgDir)), "yaml")].find((d) => fs.existsSync(d));
    expect(yaml).toBeDefined();
    fs.rmSync(yaml as string, { recursive: true, force: true });
    const r = duoctl(tmp("duo-cwd-"), ["--version"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("this DUO installation is incomplete");
    expect(r.stderr).toContain("Reinstall the @duo-director/cli package");
  });
});
