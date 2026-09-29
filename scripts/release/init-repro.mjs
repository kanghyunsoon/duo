#!/usr/bin/env node
/**
 * C209 targeted reproduction (TASK-020): the installed release candidate's `duoctl init` on a fresh small
 * Git repository, repeated. The only path of the one-time anomaly "exit 0, stdout empty". Each run records
 * exit code, stdout/stderr byte counts, spawn error, signal, whether stdout is exactly one JSON value, and
 * whether Truth, the index state and the adoption baseline exist. No source, task or output text is logged.
 *
 *   node scripts/release/init-repro.mjs --prefix <npm prefix with @duo-director/cli> [--runs 20]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const prefix = opt("--prefix");
const runs = Number(opt("--runs", "20"));
if (prefix === undefined) throw new Error("--prefix <npm prefix> is required");
const IS_WIN = process.platform === "win32";
const bin = IS_WIN ? prefix : path.join(prefix, "bin");
const git = (cwd, ...a) => spawnSync("git", a, { cwd, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" } });
// PATH: the installed shim first, then Node and Git; no workspace, pnpm or NODE_PATH.
const gitDir = path.dirname(spawnSync(IS_WIN ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/u)[0].trim());
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PATH|NODE_PATH|NODE_OPTIONS|npm_.*|PNPM.*)$/iu.test(k)));
env.PATH = [bin, path.dirname(process.execPath), gitDir, ...(IS_WIN ? [] : ["/usr/bin", "/bin"])].join(path.delimiter);
env.DUO_LOCALE = "";
env.OPENAI_API_KEY = "";

function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-c209-")));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Ledger\n\nShared expenses.\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "ledger", version: "1.0.0", type: "module" }));
  fs.writeFileSync(path.join(root, "src", "ledger.ts"), "export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n");
  fs.writeFileSync(path.join(root, "src", "ledger.test.ts"), "import { total } from './ledger.js';\nexport const t = total([1, 2]);\n");
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  return root;
}
const quote = (a) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
const initArgs = ["init", "--non-interactive", "--answers", "-", "--json"];
const results = [];
for (let i = 0; i < runs; i++) {
  const root = repository();
  // Alternate the two launch paths a user has: the npm shim on PATH (cmd.exe on Windows) and node + bundle.
  const via = i % 2 === 0 ? "path-shim" : "node-entry";
  const started = Date.now();
  const r = via === "path-shim"
    ? (IS_WIN
      ? spawnSync(["duoctl", ...initArgs].map(quote).join(" "), { cwd: root, env, input: "[]", encoding: "utf8", windowsHide: true, shell: true, timeout: 600_000 })
      : spawnSync("duoctl", initArgs, { cwd: root, env, input: "[]", encoding: "utf8", timeout: 600_000 }))
    : spawnSync(process.execPath, [path.join(prefix, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli", "dist", "duoctl.js"), ...initArgs], { cwd: root, env, input: "[]", encoding: "utf8", windowsHide: true, timeout: 600_000 });
  const stdout = r.stdout ?? "";
  let jsonOk = false;
  let resultOk = false;
  try { const j = JSON.parse(stdout); jsonOk = true; resultOk = j.ok === true && j.result?.steps?.index?.status === "ok"; } catch { /* recorded below */ }
  const exists = (p) => fs.existsSync(path.join(root, p));
  const reviews = exists(".duo-project/reviews") ? fs.readdirSync(path.join(root, ".duo-project/reviews")).filter((f) => f.startsWith("adoption-")).length : 0;
  results.push({
    run: i + 1, via, ms: Date.now() - started, exit: r.status, signal: r.signal, spawnError: r.error?.code ?? null,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(r.stderr ?? ""), jsonOk, resultOk,
    truth: exists(".duo-project/project.yaml"), indexState: exists(".duo-project/generated/index-state.json"), baseline: reviews,
  });
  fs.rmSync(root, { recursive: true, force: true });
}
const anomalies = results.filter((x) => x.exit === 0 && x.stdoutBytes === 0);
const failures = results.filter((x) => x.exit !== 0 || !x.jsonOk || !x.resultOk || !x.truth || !x.indexState || x.baseline !== 1);
const summary = { format: "duo.c209-repro/1", os: process.platform, node: process.version, runs, anomalies: anomalies.length, failures: failures.length, results };
console.log(JSON.stringify(summary));
process.exit(failures.length === 0 ? 0 : 1);
