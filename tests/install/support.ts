/**
 * Agent integration E2E support (TASK-017): an installed-looking duoctl. A temporary bin directory
 * holds a duoctl launcher (duoctl.cmd on Windows, an executable script elsewhere) that runs the built
 * CLI, and an environment whose PATH starts with it, as after a global install.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_MAIN } from "../cli/support.js";

export function duoctlBin(temps: string[]): string {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-bin-")));
  temps.push(bin);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "duoctl.cmd"), `@echo off\r\n"${process.execPath}" "${CLI_MAIN}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "duoctl"), `#!/bin/sh\nexec "${process.execPath}" "${CLI_MAIN}" "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

/** process.env with PATH = dirs + (keepPath ? the current PATH : nothing). One PATH key, also on Windows. */
export function envWithPath(dirs: readonly string[], keepPath = true): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  let current = "";
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === "PATH") current = v ?? "";
    else out[k] = v;
  }
  out.PATH = [...dirs, ...(keepPath && current !== "" ? [current] : [])].join(path.delimiter);
  return out;
}

/** Only string values (for an MCP client transport environment). */
export const stringEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
