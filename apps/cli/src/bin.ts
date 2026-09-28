#!/usr/bin/env node
/**
 * The duoctl executable (package.json bin, T17.1). It checks the Node.js version first, then loads the
 * CLI. The CLI itself (main.ts) is the same in the workspace and in the published package; this file
 * only guards the start: an unsupported Node or an incomplete installation gets a clear message.
 */
import { nodeVersionProblem } from "./node-version.js";
import { NODE_ENGINE } from "./version.js";

const problem = nodeVersionProblem(process.version, NODE_ENGINE);
if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
try {
  await import("./main.js");
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  if (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND") {
    process.stderr.write(`duoctl: this DUO installation is incomplete (${e.message.split("\n")[0] ?? ""}). Reinstall the @duo-director/cli package.\n`);
    process.exit(1);
  }
  throw error;
}
