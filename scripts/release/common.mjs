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

/**
 * H-65: an installed @duo-director/cli against the runtime tree it carries (dist/runtime-tree.json): every recorded
 * package at its recorded path inside the package with the recorded version and content hash (the same hash pack-cli
 * writes), no other package directory inside it, and no third-party package next to it in the install root
 * (nothing hoisted or fetched). Returns { packages, checked, mismatches, extra, outside }.
 */
export function compareInstalledTree(pkgDir, installRoot) {
  const tree = readJson(path.join(pkgDir, "dist", "runtime-tree.json"));
  const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const dirs = (nm, rel) => {
    const out = [];
    if (!fs.existsSync(nm)) return out;
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const names = e.name.startsWith("@") ? fs.readdirSync(path.join(nm, e.name)).map((s) => e.name + "/" + s) : [e.name];
      for (const n of names) { out.push(rel + "/" + n); out.push(...dirs(path.join(nm, ...n.split("/"), "node_modules"), rel + "/" + n + "/node_modules")); }
    }
    return out;
  };
  const mismatches = [];
  for (const p of tree.packages) {
    const dir = path.join(pkgDir, ...p.path.split("/"));
    if (!fs.existsSync(path.join(dir, "package.json"))) { mismatches.push(p.path + ": missing"); continue; }
    const version = readJson(path.join(dir, "package.json")).version;
    if (version !== p.version) { mismatches.push(p.path + ": " + version + " != " + p.version); continue; }
    const files = [];
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const rel = path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/");
      if (e.isFile() && !rel.split("/").includes("node_modules")) files.push(rel);
    }
    files.sort(byCode);
    const hash = createHash("sha256").update(files.map((f) => f + "\0" + sha256(path.join(dir, ...f.split("/"))) + "\n").join("")).digest("hex");
    if (files.length !== p.files || hash !== p.contentHash) mismatches.push(p.path + ": content differs (" + files.length + " files, recorded " + p.files + ")");
  }
  const recorded = new Set(tree.packages.map((p) => p.path));
  const extra = dirs(path.join(pkgDir, "node_modules"), "node_modules").filter((d) => !recorded.has(d));
  const outside = dirs(installRoot, "node_modules").filter((d) => d !== "node_modules/@duo-director/cli" && !d.startsWith("node_modules/@duo-director/cli/"));
  return { format: tree.format, packages: tree.packages.length, treeHash: tree.treeHash, checked: tree.packages.length - mismatches.filter((m) => m.endsWith(": missing")).length, mismatches, extra, outside };
}
