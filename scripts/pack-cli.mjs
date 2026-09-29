#!/usr/bin/env node
/**
 * Builds the publishable @duo-director/cli package and packs it with npm (T17.1). Nothing is published.
 *
 *   node scripts/pack-cli.mjs [--out <dir>]      (default .dist/; run pnpm build first)
 *
 * Topology (ADR-011, C158): one public package. The internal workspace packages (@duo-director/core,
 * analyzer, graph, director, integration) are bundled into it with esbuild; third-party runtime
 * dependencies stay npm dependencies at the exact versions the workspace declares. The tree-sitter
 * grammar packages are not dependencies (their install scripts build native addons): the WASM files
 * the analyzer names (GRAMMAR_FILES, T18.0: TypeScript, TSX, JavaScript, Java, C#, C++, Python) are
 * vendored into dist/grammars/ with their licenses and dist/grammars/grammars.json (package, version,
 * repository, license, sha256, bytes, ABI). The tarball npm pack writes is the artifact oracle;
 * <out>/pack.json describes it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, ".dist"));
const STAGE = path.join(OUT, "cli-package");
const INTERNAL = ["core", "analyzer", "graph", "director", "integration"];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const fail = (message) => { console.error(`pack-cli: ${message}`); process.exit(1); };
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const cli = readJson(path.join(ROOT, "apps/cli/package.json"));
const entry = path.join(ROOT, "apps/cli/dist/bin.js");
if (!fs.existsSync(entry)) fail("apps/cli/dist/bin.js is missing: run pnpm build first");
if (cli.license !== "Apache-2.0") fail(`apps/cli/package.json license is ${JSON.stringify(cli.license)}; DUO is Apache-2.0 (H-44)`);
const licenseText = fs.existsSync(path.join(ROOT, "LICENSE")) ? fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8").replaceAll("\r\n", "\n") : "";
if (!/^\s*Apache License\n\s*Version 2\.0, January 2004\n/u.test(licenseText) || !licenseText.includes("END OF TERMS AND CONDITIONS")) fail("the repository LICENSE is not the Apache License 2.0 text");

// The grammars the analyzer loads: its built GRAMMAR_FILES is the one list ("<package>/<file>.wasm").
const runtime = path.join(ROOT, "packages/analyzer/dist/language/tree-sitter/runtime.js");
if (!fs.existsSync(runtime)) fail("packages/analyzer/dist is missing: run pnpm build first");
const { GRAMMAR_FILES } = await import(pathToFileURL(runtime).href);
const GRAMMARS = Object.entries(GRAMMAR_FILES).sort(([a], [b]) => (a < b ? -1 : 1));
const GRAMMAR_PACKAGES = new Set(GRAMMARS.map(([, file]) => file.slice(0, file.indexOf("/"))));
const analyzerDeps = readJson(path.join(ROOT, "packages/analyzer/package.json")).dependencies ?? {};
for (const pkg of GRAMMAR_PACKAGES) if (analyzerDeps[pkg] === undefined) fail(`the analyzer loads a grammar from ${pkg}, which it does not declare`);

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

// Grammar WASM files, their licenses and grammars.json, from the analyzer's own dependency versions.
const fromAnalyzer = createRequire(path.join(ROOT, "packages/analyzer/package.json"));
const { Language, Parser } = await import(pathToFileURL(fromAnalyzer.resolve("web-tree-sitter")).href);
await Parser.init();
const grammarManifest = [];
for (const [id, g] of GRAMMARS) {
  const source = fromAnalyzer.resolve(g);
  const target = path.join(STAGE, "dist", "grammars", path.basename(g));
  fs.copyFileSync(source, target);
  const pkg = g.slice(0, g.indexOf("/"));
  const meta = readJson(path.join(path.dirname(fromAnalyzer.resolve(`${pkg}/package.json`)), "package.json"));
  const repository = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  const language = await Language.load(source);
  grammarManifest.push({
    grammar: id, file: path.basename(g), package: pkg, version: meta.version, ...(repository === undefined ? {} : { repository: repository.replace(/^git\+/u, "") }),
    license: meta.license, sha256: sha256(target), bytes: fs.statSync(target).size, abi: language.abiVersion,
  });
}
fs.writeFileSync(path.join(STAGE, "dist", "grammars", "grammars.json"), `${JSON.stringify(grammarManifest, null, 2)}\n`);

// The local UI (T18.1): the built static assets next to the bundle (dist/ui/), where the server looks first.
// React is inside app.js; the package gains no runtime dependency. No source maps.
const UI_ASSETS = ["index.html", "app.js", "app.css"];
const uiBuilt = path.join(ROOT, "packages", "ui", "dist", "app");
fs.mkdirSync(path.join(STAGE, "dist", "ui"), { recursive: true });
for (const f of UI_ASSETS) {
  if (!fs.existsSync(path.join(uiBuilt, f))) fail(`packages/ui/dist/app/${f} is missing: run pnpm build first`);
  fs.copyFileSync(path.join(uiBuilt, f), path.join(STAGE, "dist", "ui", f));
}
const extraUi = fs.readdirSync(uiBuilt).filter((f) => !UI_ASSETS.includes(f));
if (extraUi.length > 0) fail(`unexpected UI build output: ${extraUi.join(", ")}`);
for (const pkg of GRAMMAR_PACKAGES) {
  const dir = path.dirname(fromAnalyzer.resolve(`${pkg}/package.json`));
  const license = fs.readdirSync(dir).find((f) => /^LICENSE/iu.test(f));
  if (license === undefined) fail(`${pkg} has no LICENSE file`);
  const version = readJson(path.join(dir, "package.json")).version;
  fs.writeFileSync(path.join(STAGE, "dist", "grammars", `LICENSE-${pkg}`), `${pkg}@${version} (vendored WASM grammar)\n\n${fs.readFileSync(path.join(dir, license), "utf8")}`);
}

// Third-party notices (Release Hardening). DUO's own license is separate (C164). Three kinds of third-party code:
// code bundled into dist/ui/app.js (its license texts, from the UI build), vendored grammar WASM (LICENSE-* files
// next to them) and npm runtime dependencies (installed as their own packages with their own license files).
const uiLicensesFile = path.join(ROOT, "packages", "ui", "dist", "licenses.json");
if (!fs.existsSync(uiLicensesFile)) fail("packages/ui/dist/licenses.json is missing: run pnpm build first");
const uiLicenses = readJson(uiLicensesFile);
if (uiLicenses.format !== "duo.ui-licenses/1" || uiLicenses.packages.length === 0) fail("packages/ui/dist/licenses.json lists no bundled package");
const notices = [
  "# Third-party notices for @duo-director/cli",
  "",
  "This file covers third-party software shipped in this package. It is not DUO's own license.",
  "",
  "## Bundled into dist/ui/app.js",
  "",
  ...uiLicenses.packages.flatMap((p) => [`### ${p.name}@${p.version} (${p.license})`, "", "```text", p.text.trimEnd(), "```", ""]),
  "## Vendored Tree-sitter grammars (dist/grammars/)",
  "",
  "Each WASM file is accompanied by its license in dist/grammars/LICENSE-<package>; versions and hashes are in dist/grammars/grammars.json.",
  "",
  ...[...GRAMMAR_PACKAGES].sort().map((p) => `- ${p}: dist/grammars/LICENSE-${p}`),
  "",
  "## npm runtime dependencies",
  "",
  "Installed by npm as separate packages, each with its own license files:",
  "",
  ...Object.entries(sortedDeps).map(([name, version]) => `- ${name}@${version}`),
  "",
];
fs.writeFileSync(path.join(STAGE, "dist", "THIRD_PARTY_NOTICES.md"), notices.join("\n"));

const manifest = {
  name: cli.name,
  version: cli.version,
  description: cli.description,
  // DUO's own license (H-44: Apache-2.0). apps/cli/package.json is the one source; no placeholder value.
  license: cli.license,
  // Public links come from apps/cli/package.json (the one metadata source); release:preflight checks they resolve.
  ...(cli.repository === undefined ? {} : { repository: cli.repository }),
  ...(cli.homepage === undefined ? {} : { homepage: cli.homepage }),
  ...(cli.bugs === undefined ? {} : { bugs: cli.bugs }),
  type: "module",
  bin: { duoctl: "dist/duoctl.js" },
  // npm-packlist always adds README, LICENSE and package.json, never npm-shrinkwrap.json: it must be listed (C163).
  files: fs.existsSync(path.join(ROOT, "apps", "cli", "npm-shrinkwrap.json")) ? ["dist", "npm-shrinkwrap.json"] : ["dist"],
  engines: cli.engines,
  dependencies: sortedDeps,
  keywords: ["duo", "coding-agent", "mcp", "codex", "claude-code", "project-direction"],
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(STAGE, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(ROOT, "apps/cli/README.md"), path.join(STAGE, "README.md"));
// The repository LICENSE ships unchanged; third-party licenses stay in dist/THIRD_PARTY_NOTICES.md and dist/grammars/.
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(STAGE, "LICENSE"));

// C163: the committed npm-shrinkwrap.json pins the transitive runtime tree. It must describe exactly this
// manifest (name, version, direct dependencies); otherwise run pnpm release:lock and review the diff.
const shrinkwrapSource = path.join(ROOT, "apps", "cli", "npm-shrinkwrap.json");
if (fs.existsSync(shrinkwrapSource)) {
  const lock = readJson(shrinkwrapSource);
  const root = lock.packages?.[""] ?? {};
  const same = lock.lockfileVersion === 3 && root.name === manifest.name && root.version === manifest.version
    && JSON.stringify(root.dependencies ?? {}) === JSON.stringify(sortedDeps);
  if (!same) fail("apps/cli/npm-shrinkwrap.json does not match the package (name, version or dependencies): run pnpm release:lock");
  const foreign = Object.entries(lock.packages).filter(([k, v]) => k !== "" && !String(v.resolved ?? "").startsWith("https://registry.npmjs.org/"));
  if (foreign.length > 0) fail(`npm-shrinkwrap.json resolves outside registry.npmjs.org: ${foreign.map(([k]) => k).join(", ")}`);
  fs.copyFileSync(shrinkwrapSource, path.join(STAGE, "npm-shrinkwrap.json"));
} else if (process.env.DUO_ALLOW_MISSING_SHRINKWRAP !== "1") {
  fail("apps/cli/npm-shrinkwrap.json is missing: run pnpm release:lock");
}

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
