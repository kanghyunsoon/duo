#!/usr/bin/env node
/**
 * Builds the publishable @duo-director/cli package and packs it with npm (T17.1). Nothing is published.
 *
 *   node scripts/pack-cli.mjs [--out <dir>]      (default .dist/; run pnpm build first)
 *
 * Topology (ADR-011, C158): one public package. The internal workspace packages (@duo-director/core,
 * analyzer, graph, director, integration) are bundled into it with esbuild; third-party runtime
 * dependencies stay npm dependencies at the exact versions the workspace declares. The tree-sitter
 * grammar packages are not dependencies (their install scripts build native addons): their three WASM
 * files are vendored into dist/grammars/ with their licenses. The tarball npm pack writes is the
 * artifact oracle; <out>/pack.json describes it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, ".dist"));
const STAGE = path.join(OUT, "cli-package");
const INTERNAL = ["core", "analyzer", "graph", "director", "integration"];
const GRAMMAR_PACKAGES = new Set(["tree-sitter-typescript", "tree-sitter-javascript"]);
const GRAMMARS = ["tree-sitter-typescript/tree-sitter-typescript.wasm", "tree-sitter-typescript/tree-sitter-tsx.wasm", "tree-sitter-javascript/tree-sitter-javascript.wasm"];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const fail = (message) => { console.error(`pack-cli: ${message}`); process.exit(1); };
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const cli = readJson(path.join(ROOT, "apps/cli/package.json"));
const entry = path.join(ROOT, "apps/cli/dist/bin.js");
if (!fs.existsSync(entry)) fail("apps/cli/dist/bin.js is missing: run pnpm build first");

// Runtime dependencies: every third-party dependency of the bundled workspace packages, exact versions.
const dependencies = {};
for (const name of INTERNAL) {
  for (const [dep, version] of Object.entries(readJson(path.join(ROOT, "packages", name, "package.json")).dependencies ?? {})) {
    if (version.startsWith("workspace:") || GRAMMAR_PACKAGES.has(dep)) continue;
    if (!/^\d+\.\d+\.\d+$/u.test(version)) fail(`${name} depends on ${dep}@${version}: runtime dependencies must be exact versions`);
    if (dependencies[dep] !== undefined && dependencies[dep] !== version) fail(`${dep} is declared as ${dependencies[dep]} and ${version}`);
    dependencies[dep] = version;
  }
}
const sortedDeps = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)));

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, "dist", "grammars"), { recursive: true });

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: { duoctl: entry },
  outdir: path.join(STAGE, "dist"),
  entryNames: "[name]",
  chunkNames: "cli-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: Object.keys(sortedDeps).flatMap((d) => [d, `${d}/*`]),
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});

// Every import left in the bundle must be a Node builtin or a declared runtime dependency.
const builtins = new Set(builtinModules);
const bare = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
for (const [file, output] of Object.entries(result.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external) continue;
    const spec = imp.path;
    if (spec.startsWith("node:") || builtins.has(spec)) continue;
    if (spec.startsWith("@duo-director/")) fail(`${file} still imports ${spec}: internal packages must be bundled`);
    if (sortedDeps[bare(spec)] === undefined) fail(`${file} imports ${spec}, which is not a runtime dependency`);
  }
}
for (const file of fs.readdirSync(path.join(STAGE, "dist")).filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(STAGE, "dist", file), "utf8");
  for (const p of [ROOT, ROOT.replaceAll("\\", "/"), ROOT.replaceAll("\\", "\\\\")]) if (text.includes(p)) fail(`${file} contains the development path ${p}`);
}

// Grammar WASM files and their licenses, from the analyzer's own dependency versions.
const fromAnalyzer = createRequire(path.join(ROOT, "packages/analyzer/package.json"));
for (const g of GRAMMARS) fs.copyFileSync(fromAnalyzer.resolve(g), path.join(STAGE, "dist", "grammars", path.basename(g)));
for (const pkg of GRAMMAR_PACKAGES) {
  const dir = path.dirname(fromAnalyzer.resolve(`${pkg}/package.json`));
  const license = fs.readdirSync(dir).find((f) => /^LICENSE/iu.test(f));
  if (license === undefined) fail(`${pkg} has no LICENSE file`);
  const version = readJson(path.join(dir, "package.json")).version;
  fs.writeFileSync(path.join(STAGE, "dist", "grammars", `LICENSE-${pkg}`), `${pkg}@${version} (vendored WASM grammar)\n\n${fs.readFileSync(path.join(dir, license), "utf8")}`);
}

const manifest = {
  name: cli.name,
  version: cli.version,
  description: cli.description,
  license: cli.license ?? "UNLICENSED",
  type: "module",
  bin: { duoctl: "dist/duoctl.js" },
  files: ["dist"],
  engines: cli.engines,
  dependencies: sortedDeps,
  keywords: ["duo", "coding-agent", "mcp", "codex", "claude-code", "project-direction"],
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(STAGE, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(ROOT, "apps/cli/README.md"), path.join(STAGE, "README.md"));

/** npm's own CLI script beside this Node (no shell, no .cmd shim); the PATH npm otherwise. */
function npmCommand() {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  return ["npm", []];
}
const [npmBin, npmPrefix] = npmCommand();
const packed = JSON.parse(execFileSync(npmBin, [...npmPrefix, "pack", STAGE, "--pack-destination", OUT, "--json", "--ignore-scripts"], {
  encoding: "utf8", windowsHide: true, cwd: OUT,
}))[0];
const files = {};
for (const f of fs.readdirSync(STAGE, { recursive: true, withFileTypes: true })) {
  if (!f.isFile()) continue;
  const abs = path.join(f.parentPath, f.name);
  files[path.relative(STAGE, abs).replaceAll("\\", "/")] = sha256(abs);
}
const report = {
  name: packed.name, version: packed.version, tarball: path.join(OUT, packed.filename), size: packed.size, unpackedSize: packed.unpackedSize,
  integrity: packed.integrity, entryCount: packed.entryCount, files: packed.files.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  sha256: files, dependencies: sortedDeps,
};
fs.writeFileSync(path.join(OUT, "pack.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`pack-cli: ${packed.filename} · ${packed.size} bytes packed · ${packed.unpackedSize} bytes unpacked · ${packed.entryCount} files`);
