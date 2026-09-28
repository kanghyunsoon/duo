/**
 * The DUO launcher an agent spawns (TASK-017). The configuration records a bare command name resolved
 * by the agent through PATH (duoctl), or the project-local npx launcher; never a developer's local
 * source path. Before configuring, the installer checks that the agent could find the launcher and that
 * no repository file could stand in for it (Windows process search may look in the working directory).
 */
import fs from "node:fs";
import path from "node:path";
import { createDiagnostic, type Diagnostic } from "@duo-director/core";
import type { DuoLauncher } from "./types.js";

export const PATH_LAUNCHER: DuoLauncher = { kind: "path", command: "duoctl", argsPrefix: [] };
export const NPX_LAUNCHER: DuoLauncher = { kind: "npx", command: "npx", argsPrefix: ["--no-install", "duoctl"] };

export interface HostEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

export const currentHost = (): HostEnvironment => ({ env: process.env, platform: process.platform });

const BARE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".com", ".ps1"];

function pathValue(host: HostEnvironment): string {
  if (host.platform !== "win32") return host.env.PATH ?? "";
  const key = Object.keys(host.env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? "" : host.env[key] ?? "";
}

function candidates(dir: string, name: string, host: HostEnvironment): string[] {
  if (host.platform !== "win32") return [path.join(dir, name)];
  const exts = (host.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "").map((e) => e.toLowerCase());
  return path.extname(name) !== "" ? [path.join(dir, name)] : exts.map((e) => path.join(dir, name + e));
}

/** The file a bare command resolves to on PATH, or undefined. Read-only. */
export function findOnPath(name: string, host: HostEnvironment = currentHost()): string | undefined {
  for (const dir of pathValue(host).split(host.platform === "win32" ? ";" : ":")) {
    if (dir === "" || !path.isAbsolute(dir)) continue; // relative PATH entries resolve against a cwd: not trusted
    for (const file of candidates(dir, name, host)) {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (host.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Repository entries named like the command (duoctl, duoctl.cmd, …) that could shadow it. */
function shadowing(root: string, command: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const lower = command.toLowerCase();
  return names.filter((n) => { const l = n.toLowerCase(); return l === lower || WINDOWS_EXTS.some((e) => l === lower + e); }).sort();
}

export interface LauncherCheck {
  readonly available: boolean;
  /** Where it resolved on this machine (reported, never written into a configuration). */
  readonly resolved?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly warnings: readonly string[];
}

export function checkLauncher(root: string, launcher: DuoLauncher, host: HostEnvironment = currentHost()): LauncherCheck {
  const diagnostics: Diagnostic[] = [];
  const warnings: string[] = [];
  const { command } = launcher;
  if (!BARE.test(command) && !path.isAbsolute(command)) {
    return { available: false, warnings, diagnostics: [createDiagnostic("AGENT_LAUNCHER_UNAVAILABLE", `launcher command "${command}" must be a bare command name on PATH or an absolute path; relative paths are refused`)] };
  }
  if (path.isAbsolute(command)) {
    warnings.push(`launcher "${command}" is an absolute path: the configuration will not work on other machines or after a move`);
    const ok = fs.existsSync(command);
    if (!ok) diagnostics.push(createDiagnostic("AGENT_LAUNCHER_UNAVAILABLE", `launcher "${command}" does not exist`));
    return { available: ok, ...(ok ? { resolved: command } : {}), diagnostics, warnings };
  }
  const shadow = shadowing(root, command);
  if (shadow.length > 0) {
    diagnostics.push(createDiagnostic("AGENT_INTEGRATION_CONFLICT", `repository file ${shadow.join(", ")} could be started instead of the "${command}" launcher; remove or rename it`));
  }
  const resolved = findOnPath(command, host);
  if (resolved === undefined) {
    diagnostics.push(createDiagnostic("AGENT_LAUNCHER_UNAVAILABLE", `"${command}" is not on PATH, so the agent could not start DUO; install duoctl or choose another launcher`));
  }
  if (launcher.kind === "npx") {
    const bin = ["duoctl", "duoctl.cmd"].map((n) => path.join(root, "node_modules", ".bin", n));
    if (!bin.some((b) => fs.existsSync(b))) diagnostics.push(createDiagnostic("AGENT_LAUNCHER_UNAVAILABLE", "node_modules/.bin/duoctl is missing: the project-local launcher needs duoctl installed in this project"));
  }
  return { available: diagnostics.length === 0, ...(resolved === undefined ? {} : { resolved }), diagnostics, warnings };
}

export const launcherDisplay = (launcher: DuoLauncher): string => [launcher.command, ...launcher.argsPrefix].join(" ");
