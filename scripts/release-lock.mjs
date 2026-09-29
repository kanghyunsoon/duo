#!/usr/bin/env node
/**
 * Regenerates apps/cli/npm-shrinkwrap.json (Release Hardening, C163): the exact transitive runtime
 * dependency tree the published @duo-director/cli installs. Needs network (npm registry metadata),
 * so it is an explicit step; pack-cli only copies and checks the committed file (offline).
 *
 *   pnpm release:lock      (after pnpm build and a dependency change; review and commit the diff)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTRY = "https://registry.npmjs.org/";
const TARGET = path.join(ROOT, "apps", "cli", "npm-shrinkwrap.json");
const stageManifest = path.join(ROOT, ".dist", "cli-package", "package.json");

// The manifest the lock must describe is the one pack-cli stages (DUO_ALLOW_MISSING_SHRINKWRAP: no lock yet).
execFileSync(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs")], { cwd: ROOT, stdio: "inherit", env: { ...process.env, DUO_ALLOW_MISSING_SHRINKWRAP: "1" } });
const manifest = JSON.parse(fs.readFileSync(stageManifest, "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "duo-release-lock-"));
try {
  fs.writeFileSync(path.join(work, "package.json"), `${JSON.stringify({ name: manifest.name, version: manifest.version, dependencies: manifest.dependencies }, null, 2)}\n`);
  // Only the registry and no user config: a private registry or mirror in ~/.npmrc must not end up in "resolved".
  fs.writeFileSync(path.join(work, ".npmrc"), `registry=${REGISTRY}\n`);
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const [bin, pre] = fs.existsSync(npmCli) ? [process.execPath, [npmCli]] : ["npm", []];
  execFileSync(bin, [...pre, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", REGISTRY, "--userconfig", path.join(work, ".npmrc")], { cwd: work, stdio: "inherit", windowsHide: true });
  const lock = JSON.parse(fs.readFileSync(path.join(work, "package-lock.json"), "utf8"));
  const foreign = Object.entries(lock.packages).filter(([k, v]) => k !== "" && !(v.resolved ?? "").startsWith(REGISTRY));
  if (foreign.length > 0) throw new Error(`resolved outside ${REGISTRY}: ${foreign.map(([k]) => k).join(", ")}`);
  fs.writeFileSync(TARGET, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`release-lock: ${path.relative(ROOT, TARGET)} · ${Object.keys(lock.packages).length - 1} packages`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
