/**
 * T17.1: the packed @duo-director/cli, installed like a user would, runs DUO on an existing repository
 * without this repository: init → index → status → context → review → install codex|claude-code →
 * the generated MCP configuration started from the installed duoctl. Global (temporary npm prefix) and
 * project-local (npx --no-install) installs. Nothing falls back to the workspace build.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
    const grammar = /^dist\/grammars\/(tree-sitter-(typescript|tsx|javascript|java|c_sharp|cpp|python)\.wasm|LICENSE-tree-sitter-(typescript|javascript|java|c-sharp|cpp|python)|grammars\.json)$|^dist\/ui\/(index\.html|app\.js|app\.css)$/u;
    for (const f of files) expect(f, f).toMatch(/^(package\.json|npm-shrinkwrap\.json|README\.md|LICENSE|dist\/THIRD_PARTY_NOTICES\.md|dist\/duoctl\.js|dist\/cli-[A-Z0-9]+\.js)$/u.test(f) ? /./u : grammar);
    expect(files).toEqual(expect.arrayContaining(["dist/duoctl.js", "dist/grammars/grammars.json", ...["typescript", "tsx", "javascript", "java", "c_sharp", "cpp", "python"].map((g) => `dist/grammars/tree-sitter-${g}.wasm`)]));
    const forbidden = /(^|\/)(\.env|\.worklog|fixtures|coverage|\.duo-project|node_modules|tmp)(\/|$)|credentials|\.pem$|\.key$|id_rsa|\.p12$|metrics\.jsonl|\.map$|\.test\.|\.tgz$/iu;
    expect(files.filter((f) => forbidden.test(f))).toEqual([]);
  });

  it("grammars.json names every vendored grammar: package, exact version, MIT license, sha256 of the packed file, ABI the runtime loads (T18.0)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, ".dist", "cli-package", "dist", "grammars", "grammars.json"), "utf8")) as { grammar: string; file: string; package: string; version: string; license: string; sha256: string; bytes: number; abi: number }[];
    expect(manifest.map((g) => g.grammar)).toEqual(["cpp", "csharp", "java", "javascript", "python", "tsx", "typescript"]);
    const analyzer = JSON.parse(fs.readFileSync(path.join(REPO, "packages", "analyzer", "package.json"), "utf8")).dependencies as Record<string, string>;
    for (const g of manifest) {
      expect(g.version, g.grammar).toBe(analyzer[g.package]);
      expect(g.license, g.grammar).toBe("MIT");
      expect(g.sha256, g.grammar).toBe(pack.sha256[`dist/grammars/${g.file}`]);
      expect([14, 15], g.grammar).toContain(g.abi);
      expect(pack.files.map((f) => f.path)).toContain(`dist/grammars/LICENSE-${g.package}`);
    }
    recordMetric("grammars", manifest.map((g) => ({ grammar: g.grammar, package: `${g.package}@${g.version}`, bytes: g.bytes, abi: g.abi })));
  });

  it("package.json: public name and bin, Node engine, exact runtime dependencies only, no scripts, no workspace links", () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO, ".dist", "cli-package", "package.json"), "utf8"));
    expect(m).toMatchObject({ name: "@duo-director/cli", bin: { duoctl: "dist/duoctl.js" }, engines: { node: ">=24.15.0" }, type: "module", files: ["dist", "npm-shrinkwrap.json"] });
    expect(pack.files.map((f) => f.path)).toContain("npm-shrinkwrap.json");
    expect(m.version).toMatch(/^0\.\d+\.\d+$/u);
    expect(m.version).toBe(JSON.parse(fs.readFileSync(path.join(REPO, "apps", "cli", "package.json"), "utf8")).version);
    expect(m.scripts).toBeUndefined();
    expect(m.devDependencies).toBeUndefined();
    expect(m.private).toBeUndefined();
    for (const [n, v] of Object.entries(m.dependencies as Record<string, string>)) {
      expect(v, n).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(n).not.toMatch(/^@duo-director\/|^tree-sitter-/u);
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

  it("Release Hardening: third-party notices cover the code bundled into the UI, the vendored grammars and the runtime dependencies", () => {
    const stage = path.join(REPO, ".dist", "cli-package");
    const notices = fs.readFileSync(path.join(stage, "dist", "THIRD_PARTY_NOTICES.md"), "utf8");
    const ui = JSON.parse(fs.readFileSync(path.join(REPO, "packages", "ui", "dist", "licenses.json"), "utf8")) as { packages: { name: string; version: string; text: string }[] };
    expect(ui.packages.map((p) => p.name)).toEqual(expect.arrayContaining(["react", "react-dom", "scheduler"]));
    for (const p of ui.packages) {
      expect(notices, p.name).toContain(`### ${p.name}@${p.version}`);
      expect(notices, p.name).toContain(p.text.trimEnd());
    }
    for (const [name, version] of Object.entries(pack.dependencies)) expect(notices).toContain(`- ${name}@${version}`);
    expect(notices).toContain("It is not DUO's own license.");
  });

  it("DUO's own license (H-44): Apache-2.0 metadata and the repository LICENSE, separate from third-party notices", () => {
    const stage = path.join(REPO, ".dist", "cli-package");
    const m = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
    expect(m.license).toBe("Apache-2.0");
    expect(pack.files.map((f) => f.path)).toContain("LICENSE");
    const license = fs.readFileSync(path.join(stage, "LICENSE"), "utf8");
    expect(license).toBe(fs.readFileSync(path.join(REPO, "LICENSE"), "utf8"));
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(fs.readFileSync(path.join(stage, "dist", "THIRD_PARTY_NOTICES.md"), "utf8")).not.toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.");
  });

  it("Release Hardening (C163): npm-shrinkwrap.json pins the runtime tree to registry.npmjs.org; metadata links are public URLs", () => {
    const stage = path.join(REPO, ".dist", "cli-package");
    const m = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(stage, "npm-shrinkwrap.json"), "utf8")) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; name?: string; dependencies?: Record<string, string> }> };
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]).toMatchObject({ name: m.name, version: m.version, dependencies: m.dependencies });
    for (const [k, v] of Object.entries(lock.packages)) {
      if (k === "") continue;
      expect(v.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(v.integrity, k).toMatch(/^sha512-/u);
    }
    for (const field of [m.repository?.url, m.homepage, m.bugs?.url]) expect(field).toMatch(/^(git\+)?https:\/\/github\.com\/kanghyunsoon\/duo/u);
    expect(JSON.stringify(m)).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//u);
  });
});

describe("global install (temporary npm prefix)", () => {
  it("installs without native builds or install scripts; the installed files are the packed ones", () => {
    const pkgs = installedPackages(path.dirname(path.dirname(pkgDir)));
    const scripted = pkgs.filter((p) => ["preinstall", "install", "postinstall"].some((s) => s in p.scripts) || p.gyp);
    expect(scripted).toEqual([]);
    expect(pkgs.map((p) => p.name).filter((n) => n === "node-gyp" || n === "node-gyp-build" || n.startsWith("tree-sitter-"))).toEqual([]);
    for (const [f, sha] of Object.entries(pack.sha256)) expect(createHash("sha256").update(fs.readFileSync(path.join(pkgDir, f))).digest("hex"), f).toBe(sha);
    recordMetric("globalInstall", { packages: pkgs.length, bytesOnDisk: dirSize(IS_WIN ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules")), names: pkgs.map((x) => `${x.name}@${x.version}`).sort() });
  });

  it("Release Hardening (C163): the installed dependency tree is exactly the shrinkwrapped one", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(pkgDir, "npm-shrinkwrap.json"), "utf8")) as { packages: Record<string, { version?: string; optional?: boolean; os?: string[]; cpu?: string[] }> };
    const mismatched: string[] = [];
    let checked = 0;
    for (const [k, v] of Object.entries(lock.packages)) {
      if (k === "") continue;
      const manifestFile = path.join(pkgDir, ...k.split("/"), "package.json");
      const platformSkipped = v.optional === true && ((v.os !== undefined && !v.os.includes(process.platform)) || (v.cpu !== undefined && !v.cpu.includes(process.arch)));
      if (!fs.existsSync(manifestFile)) { if (!platformSkipped) mismatched.push(`${k}: missing`); continue; }
      const installed = JSON.parse(fs.readFileSync(manifestFile, "utf8")).version;
      if (installed !== v.version) mismatched.push(`${k}: ${installed} ≠ ${v.version}`);
      checked++;
    }
    expect(mismatched).toEqual([]);
    expect(checked).toBeGreaterThan(Object.keys(lock.packages).length / 2);
    recordMetric("shrinkwrap", { packages: Object.keys(lock.packages).length - 1, checked });
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

  it("cross-language (T18.0): Java, C#, C++, Python, TypeScript and an unknown language in one repository parse with the packaged grammars", () => {
    const root = tmp("duo-poly-");
    fs.cpSync(path.join(REPO, "fixtures", "languages", "polyglot"), root, { recursive: true });
    const add = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
    add("rules/pricing.foo", "rule discount\nend\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@duo.invalid", ...args], { cwd: root, windowsHide: true, stdio: "pipe" });
    git("-c", "init.defaultBranch=main", "init", "-q");
    git("config", "core.autocrlf", "false");
    git("add", "-A");
    git("commit", "-qm", "polyglot");
    expect(duoctl(root, ["init", "--non-interactive", "--answers", "-", "--json"], "[]").code).toBe(0);
    const status = duoctl(root, ["status", "--json"]).json().result;
    expect(status.analysis.languages.map((l: { language: string; level: string }) => `${l.language}:${l.level}`)).toEqual(["cpp:L1", "csharp:L1", "java:L1", "python:L1", "typescript:L2"]);
    expect(status.analysis.fileOnly.extensions).toEqual(expect.arrayContaining([{ extension: "foo", files: 1 }]));
    for (const [node, file] of [
      ["CartService.cartTotal", "api/src/main/java/com/example/api/CartService.java"], ["Storefront.Game.Score.CartTotal", "game/Assets/Scripts/Score.cs"],
      ["cart_total", "ml/recommender/rank.py"], ["cartTotal", "web/src/cart.ts"], ["sym:native/src/checksum.cpp#checksum", "native/src/checksum.cpp"],
    ]) {
      const tr = duoctl(root, ["trace", node as string, "--json"]);
      expect(tr.code, `${node}: ${tr.stderr}`).toBe(0);
      expect(tr.json().result.node).toMatchObject({ type: "symbol", path: file });
    }
    // The quoted include resolved to the header: the header's impact reaches the including file.
    const cpp = duoctl(root, ["impact", "native/src/checksum.hpp", "--json"]).json().result;
    expect(cpp.items.map((i: { id: string }) => i.id)).toContain("file:native/src/checksum.cpp");
    expect(cpp.limitations.map((l: { code: string }) => l.code)).toEqual(expect.arrayContaining(["imports-partial", "calls-same-file"]));
    fs.appendFileSync(path.join(root, "rules", "pricing.foo"), "rule shipping\nend\n");
    expect(duoctl(root, ["index", "--json"]).code).toBe(0);
    const rv = duoctl(root, ["review", "--json"]).json().result;
    expect(rv).toMatchObject({ status: "ready", metrics: { llmCalls: 0 } });
    expect(rv.limitations.map((l: { code: string }) => l.code)).toContain("structural-analysis-unavailable");
    // The file-only change creates no claim; a WARN here can only be the surfaced gap (this repository has no confirmed Truth).
    expect(rv.claims).toEqual([]);
    expect(rv.verdict).not.toBe("BLOCK");
  });

  it("duoctl ui (T18.1) from the installed package: bundled assets, loopback only, session cookie, API through the installed operations", async () => {
    const files = pack.files.map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(["dist/ui/index.html", "dist/ui/app.js", "dist/ui/app.css"]));
    const appJs = fs.readFileSync(path.join(pkgDir, "dist", "ui", "app.js"), "utf8");
    expect(appJs).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.(?:com|net|org|io|dev)\/[^"'\s]*\.(?:js|css|woff2?)/iu); // no CDN assets
    const p = project();
    const noKey = Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith("OPENAI_")));
    expect(runOnPath("duoctl", ["init", "--non-interactive", "--answers", "-", "--json"], p.root, noKey, "[]").code).toBe(0);
    const child = spawn(process.execPath, [path.join(pkgDir, "dist", "duoctl.js"), "ui", "--port", "0"], { cwd: p.root, env: noKey, windowsHide: true });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`no URL: ${out}`)), 120_000);
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString("utf8");
          const m = /DUO UI: (http:\/\/127\.0\.0\.1:\d+\/\?session=[\w-]+)/u.exec(out);
          if (m !== null) { clearTimeout(timer); resolve(m[1] as string); }
        });
        child.once("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      const launch = await fetch(url, { redirect: "manual" });
      expect(launch.status).toBe(303);
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const page = await fetch(new URL("/overview", url));
      expect(await page.text()).toContain('src="/assets/app.js"');
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect((await fetch(new URL("/assets/app.js", url))).status).toBe(200);
      const overview = await (await fetch(new URL("/api/overview", url), { headers: { Cookie: cookie } })).json() as { format: string; data: { status: { index: { status: string }; llm: string } } };
      expect(overview).toMatchObject({ format: "duo.ui.overview/1", data: { status: { index: { status: "current" }, llm: "disabled" } } });
      const context = await (await fetch(new URL("/api/session", url), { headers: { Cookie: cookie } })).json() as { data: { csrf: string } };
      const compiled = await fetch(new URL("/api/context", url), {
        method: "POST", headers: { Cookie: cookie, Origin: new URL(url).origin, "Content-Type": "application/json", "X-Duo-CSRF": context.data.csrf }, body: JSON.stringify({ task: "Scheduler.next" }),
      });
      expect(await compiled.json()).toMatchObject({ format: "duo.ui.context/1", data: { status: "ready" } });
    } finally {
      child.kill();
    }
  });

  it("OpenAI SDK (T12B): an exact runtime dependency, not bundled; nothing needs a key; status reports the provider without a request", () => {
    const m = JSON.parse(fs.readFileSync(path.join(REPO, ".dist", "cli-package", "package.json"), "utf8"));
    expect(m.dependencies.openai).toBe("7.23.0");
    const bundle = pack.files.map((f) => f.path).filter((f) => /^dist\/.*\.js$/u.test(f)).map((f) => fs.readFileSync(path.join(REPO, ".dist", "cli-package", f), "utf8")).join("\n");
    expect(bundle).not.toMatch(/class OpenAIError|class APIConnectionTimeoutError/u); // the SDK is not in the bundle
    expect(bundle).toMatch(/import\(\s*["']openai["']\s*\)/u); // it is loaded on the first semantic call only
    expect(fs.existsSync(path.join(path.dirname(path.dirname(pkgDir)), "openai", "package.json")) || fs.existsSync(path.join(pkgDir, "node_modules", "openai", "package.json"))).toBe(true);
    const noKey = Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith("OPENAI_")));
    const p = project();
    expect(runOnPath("duoctl", ["init", "--non-interactive", "--answers", "-", "--json"], p.root, noKey, "[]").code).toBe(0);
    fs.appendFileSync(path.join(p.root, ".duo-project", "project.yaml"), "llm:\n  provider: openai-responses\n  model: gpt-test-model\n");
    expect(runOnPath("duoctl", ["index", "--json"], p.root, noKey).code).toBe(0);
    const status = runOnPath("duoctl", ["status", "--json"], p.root, noKey).json().result;
    expect(status).toMatchObject({ llm: "unavailable", llmProvider: { provider: "openai-responses", model: "gpt-test-model", reason: "OPENAI_API_KEY is not set" } });
    const review = runOnPath("duoctl", ["review", "--semantic", "--json"], p.root, noKey).json().result;
    expect(review).toMatchObject({ status: "ready", metrics: { llmCalls: 0 } });
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
    // An empty global prefix: npm exec also looks at globally installed packages, and a machine that has
    // @duo-director/cli installed globally (any developer after the 0.1.0 release) would otherwise run that one (C215).
    const npx = runOnPath("npx", ["--no-install", "duoctl", "--version"], p.root, isolatedEnv([], { npm_config_prefix: tmp("duo-npx-empty-prefix-") }));
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
