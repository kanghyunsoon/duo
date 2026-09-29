/**
 * Shared helpers of the release scripts (Release Hardening). No script here publishes, tags, commits,
 * changes a version or creates an npm scope.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DIST = path.join(ROOT, ".dist");
export const REGISTRY = "https://registry.npmjs.org/";
export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Runs a program without a shell. */
export function run(command, args, options = {}) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status ?? (r.error ? -1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? ""), ms: Date.now() - started };
}

/** npm's own CLI next to this Node (no .cmd shim), else npm on PATH. */
export function npm(args, options = {}) {
  const cli = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p) => fs.existsSync(p));
  return cli === undefined ? run("npm", args, { shell: process.platform === "win32", ...options }) : run(process.execPath, [cli, ...args], options);
}

/** pnpm through the running package manager (pnpm run sets npm_execpath), else pnpm on PATH. */
export function pnpm(args, options = {}) {
  const exec = process.env.npm_execpath;
  if (exec !== undefined && /pnpm/iu.test(exec) && fs.existsSync(exec)) return run(process.execPath, [exec, ...args], options);
  return run("pnpm", args, { shell: process.platform === "win32", ...options });
}

export function gitState() {
  const g = (...a) => run("git", a).stdout.trim();
  const status = g("status", "--porcelain", "--untracked-files=normal");
  return { commit: g("rev-parse", "HEAD"), branch: g("rev-parse", "--abbrev-ref", "HEAD"), clean: status === "", changes: status === "" ? [] : status.split(/\r?\n/u) };
}

/** The staged package (.dist/cli-package or another pack --out) as a file → sha256 map. */
export function stagedFiles(stage) {
  const out = {};
  for (const e of fs.readdirSync(stage, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out[path.relative(stage, abs).replaceAll("\\", "/")] = sha256(abs);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
