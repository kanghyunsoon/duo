/**
 * Distribution E2E support (T17.1). The packed tarball (scripts/pack-cli.mjs → .dist/pack.json) is the
 * artifact under test. Installs go into temporary prefixes and projects outside this repository; the
 * subprocess environment is rebuilt so nothing from the workspace can be found: PATH holds only the
 * installed bin directory, Node's directory and Git's directory, and NODE_PATH, npm_* and PNPM_*
 * variables are dropped. Nothing here imports workspace source.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const IS_WIN = process.platform === "win32";

export interface PackReport {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly integrity: string;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly sha256: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export function packReport(dir = path.join(REPO, ".dist")): PackReport {
  const file = path.join(dir, "pack.json");
  if (!fs.existsSync(file)) throw new Error("run node scripts/pack-cli.mjs first (pnpm test:dist does)");
  return JSON.parse(fs.readFileSync(file, "utf8")) as PackReport;
}

/** A bare command on a PATH value (PATHEXT on Windows). */
export function which(name: string, pathValue: string): string | undefined {
  const exts = IS_WIN ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "") continue;
    for (const e of exts) {
      const f = path.join(dir, name + e);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
  }
  return undefined;
}

const hostPath = () => Object.entries(process.env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";

/**
 * The isolated environment: PATH = dirs + Node + Git + the OS base directories (POSIX /usr/bin, /bin:
 * npm exec runs bins through sh, as on any user machine); no NODE_PATH, npm_*, PNPM_* or workspace hints.
 */
export function isolatedEnv(dirs: readonly string[], extra: Record<string, string> = {}): Record<string, string> {
  const git = which("git", hostPath());
  if (git === undefined) throw new Error("git is not on PATH");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (v === undefined || K === "PATH" || K === "NODE_PATH" || K === "NODE_OPTIONS" || K.startsWith("NPM_") || K.startsWith("PNPM") || K === "VITEST" || K.startsWith("VITEST_")) continue;
    out[k] = v;
  }
  const system = IS_WIN ? [] : ["/usr/bin", "/bin"].filter((d) => fs.existsSync(d));
  out.PATH = [...new Set([...dirs, path.dirname(process.execPath), path.dirname(git), ...system])].join(path.delimiter);
  out.DUO_LOCALE = "";
  return { ...out, ...extra };
}

/** npm's own CLI script (run by this Node, no shell). */
export function npmCli(tool: "npm" | "npx" = "npm"): [string, string[]] {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, "node_modules", "npm", "bin", `${tool}-cli.js`), path.join(dir, "..", "lib", "node_modules", "npm", "bin", `${tool}-cli.js`)]) {
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  throw new Error(`${tool}-cli.js not found beside ${process.execPath}`);
}

export function npm(args: readonly string[], cwd: string, env: Record<string, string>): SpawnSyncReturns<string> {
  const [cmd, prefix] = npmCli("npm");
  return spawnSync(cmd, [...prefix, ...args], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 600_000 });
}

const quote = (a: string) => (/^[A-Za-z0-9_./:=@+-]+$/u.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);

export interface Run { readonly code: number; readonly stdout: string; readonly stderr: string; json(): any } // eslint-disable-line @typescript-eslint/no-explicit-any -- CLI JSON

/**
 * Runs a command the way a user's shell would find it on PATH: on Windows through cmd.exe (so npm's
 * duoctl.cmd / npx.cmd shims really run), elsewhere directly (the shebang).
 */
export function runOnPath(command: string, args: readonly string[], cwd: string, env: Record<string, string>, input = ""): Run {
  const r = IS_WIN
    ? spawnSync([command, ...args].map(quote).join(" "), { cwd, env, input, encoding: "utf8", windowsHide: true, shell: true, timeout: 600_000 })
    : spawnSync(command, [...args], { cwd, env, input, encoding: "utf8", timeout: 600_000 });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return {
    code: r.status ?? -1, stdout, stderr,
    json: () => {
      try {
        return JSON.parse(stdout);
      } catch (error) {
        // Release Hardening: an intermittent empty stdout (exit 0) under load; keep what is needed to diagnose it.
        throw new Error(`${command} ${args.join(" ")}: stdout is not JSON (exit ${r.status}, signal ${r.signal}, error ${r.error?.message ?? "none"}, stdout ${stdout.length} chars: ${JSON.stringify(stdout.slice(0, 200))}, stderr: ${JSON.stringify(stderr.slice(0, 800))}): ${(error as Error).message}`, { cause: error });
      }
    },
  };
}

/** Every package.json under dir (installed dependency tree). */
export function installedPackages(dir: string): { name: string; version: string; scripts: Record<string, string>; gyp: boolean }[] {
  const out: { name: string; version: string; scripts: Record<string, string>; gyp: boolean }[] = [];
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name !== "package.json") continue;
    const parent = e.parentPath;
    if (path.basename(path.dirname(parent)) !== "node_modules" && path.basename(path.dirname(path.dirname(parent))) !== "node_modules") continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(parent, e.name), "utf8")) as { name?: string; version?: string; scripts?: Record<string, string> };
      if (j.name === undefined) continue;
      out.push({ name: j.name, version: j.version ?? "", scripts: j.scripts ?? {}, gyp: fs.existsSync(path.join(parent, "binding.gyp")) });
    } catch {
      // not a package manifest
    }
  }
  return out;
}

export function dirSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size;
  return n;
}

/** Distribution metrics (sizes, counts) for the report: .dist/dist-metrics.json, merged by key. */
export function recordMetric(key: string, value: unknown): void {
  const file = path.join(REPO, ".dist", "dist-metrics.json");
  const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  fs.writeFileSync(file, `${JSON.stringify({ ...current, [key]: value, platform: process.platform, node: process.version }, null, 2)}\n`);
}

/** The duo-director launch in a Codex project config (the DUO-managed block: TOML strings and an array of strings). */
export function codexEntry(toml: string): { command: string; args: string[] } {
  const block = toml.slice(toml.indexOf("# duo-director:begin"), toml.indexOf("# duo-director:end"));
  const command = /^command = (".*")$/mu.exec(block)?.[1];
  const args = /^args = (\[.*\])$/mu.exec(block)?.[1];
  if (command === undefined || args === undefined) throw new Error("no duo-director entry in .codex/config.toml");
  return { command: JSON.parse(command) as string, args: JSON.parse(args) as string[] };
}
