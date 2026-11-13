// Per-module load profile for packed duoctl startup commands in one fresh npm prefix.
// Usage: node bench/experiments/first-run-modules.mjs [--commands version,help,status] [--iterations 5]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const local = path.join(workspace, "bench", "results", "local");
const base = path.join(local, "first-run");
const value = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const commands = value("--commands", "version,help,status").split(",").filter(Boolean);
const iterations = Number.parseInt(value("--iterations", "3"), 10);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("--iterations must be a positive integer");
if (commands.some((command) => !["version", "help", "status"].includes(command))) throw new Error("--commands accepts version, help, and status");

const pack = JSON.parse(fs.readFileSync(path.join(workspace, ".dist", "pack.json"), "utf8"));
const prefix = path.join(base, `modules-${Date.now()}`);
fs.mkdirSync(base, { recursive: true });
const npm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const installed = spawnSync(process.execPath, [npm, "install", "-g", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", pack.tarball], { encoding: "utf8", windowsHide: true });
if (installed.status !== 0) throw new Error(installed.stderr);
const hook = path.join(base, "module-hook.mjs");
fs.writeFileSync(hook, [
  "import { registerHooks } from 'node:module'; import fs from 'node:fs';",
  "const rows = [];",
  "registerHooks({ load(url, ctx, next) { const t = performance.now(); const r = next(url, ctx); if (url.startsWith('file:')) rows.push([url, performance.now() - t]); return r; } });",
  "process.on('exit', () => fs.writeFileSync(process.env.DUO_MODULE_LOG, JSON.stringify(rows)));",
].join("\n"));
const packageRoot = process.platform === "win32" ? prefix : path.join(prefix, "lib");
const entry = path.join(packageRoot, "node_modules", "@duo-director", "cli", "dist", "duoctl.js");
const root = path.join(local, "fixtures", "small");
if (!fs.existsSync(path.join(root, ".duo-project", "generated", "graph.db"))) throw new Error("run pnpm benchmark:smoke first");

const pkgOf = (url) => {
  const spec = decodeURIComponent(url).replace(/^.*node_modules\//u, "");
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const out = { format: "duo.first-run-modules/2", iterations, commands: {} };
for (const command of commands) {
  const args = command === "version" ? ["--version"] : command === "help" ? ["--help"] : ["status", "--root", root, "--json"];
  const runs = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const logFile = path.join(base, `modules-${command}-${iteration}.json`);
    const started = performance.now();
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, entry, ...args], {
      cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, DUO_MODULE_LOG: logFile, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
    });
    if (child.status !== 0) throw new Error(child.stderr);
    const rows = JSON.parse(fs.readFileSync(logFile, "utf8"));
    const byPackage = {};
    for (const [url, ms] of rows) {
      const name = pkgOf(url);
      byPackage[name] ??= { files: 0, ms: 0, bytes: 0 };
      byPackage[name].files += 1;
      byPackage[name].ms += ms;
      byPackage[name].bytes += fs.statSync(fileURLToPath(url)).size;
    }
    runs.push({
      iteration, wallMs: performance.now() - started, modules: rows.length, loadMs: rows.reduce((sum, [, ms]) => sum + ms, 0),
      packages: Object.entries(byPackage).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([name, item]) => ({ package: name, files: item.files, kb: Math.round(item.bytes / 1024), ms: item.ms })),
    });
  }
  const walls = runs.map((run) => run.wallMs);
  out.commands[command] = { medianMs: median(walls), minMs: Math.min(...walls), maxMs: Math.max(...walls), runs };
}
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(local, "first-run-modules.json"), `${JSON.stringify(out, null, 2)}\n`);
