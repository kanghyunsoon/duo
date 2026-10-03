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
 *
 * The release-locked runtime tree (C163, C242, H-65): apps/cli/npm-shrinkwrap.json is the build-time lock of the
 * third-party runtime dependencies (pnpm release:lock). The package carries that tree itself: the lock is installed
 * with npm ci into an isolated directory (registry.npmjs.org only, integrity-checked, no scripts, no bin links) and
 * those package directories are bundled (bundleDependencies) into node_modules/, files unchanged. npm 12 ignores an
 * npm-shrinkwrap.json inside an installed package and npm 10/11 ignore it for a local tarball, so the lock is not
 * shipped. dist/runtime-tree.json records each bundled package (path, name, version, lock integrity, license, file
 * count, content hash, files npm does not pack); tests and release tooling compare the installed tree with it.
 * Needs the npm registry (or a warm npm cache). DUO_PACK_MANIFEST_ONLY=1 (release:lock) stages the manifest only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, ".dist"));
const STAGE = path.join(OUT, "cli-package");
const INTERNAL = ["core", "analyzer", "graph", "director", "integration"];
const REGISTRY = "https://registry.npmjs.org/";
const LOCK_FILE = path.join(ROOT, "apps", "cli", "npm-shrinkwrap.json");
const MANIFEST_ONLY = process.env.DUO_PACK_MANIFEST_ONLY === "1";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const fail = (message) => { console.error(`pack-cli: ${message}`); process.exit(1); };
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha256Text = (text) => createHash("sha256").update(text).digest("hex");
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

/** npm's own CLI script beside this Node (no shell, no .cmd shim); the PATH npm otherwise. */
function npmCommand() {
  const dir = path.dirname(process.execPath);
  for (const cli of [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  return ["npm", []];
}

/** Package directories under a node_modules directory, as lock paths ("node_modules/a", "node_modules/a/node_modules/@s/b"), sorted. */
function packageDirs(nodeModules, rel) {
  const out = [];
  if (!fs.existsSync(nodeModules)) return out;
  for (const e of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const names = e.name.startsWith("@") ? fs.readdirSync(path.join(nodeModules, e.name)).map((s) => `${e.name}/${s}`) : [e.name];
    for (const n of names) {
      out.push(`${rel}/${n}`);
      out.push(...packageDirs(path.join(nodeModules, ...n.split("/"), "node_modules"), `${rel}/${n}/node_modules`));
    }
  }
  return out.sort(byCodePoint);
}

/** The files of one installed package (nested node_modules belong to other packages), relative with "/", sorted. */
function packageFiles(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/");
    if (rel.split("/").includes("node_modules")) continue;
    if (e.isSymbolicLink()) fail(`${dir}: ${rel} is a symbolic link; the bundled tree holds regular files only`);
    if (e.isFile()) files.push(rel);
  }
  return files.sort(byCodePoint);
}

// The release-locked runtime tree (see the header): lock → isolated npm ci → bundled node_modules/ + dist/runtime-tree.json.
let runtimeTree;
const bundledFiles = [];
const bundledNotices = [];
const pending = [];
if (!MANIFEST_ONLY) {
  if (!fs.existsSync(LOCK_FILE)) fail("apps/cli/npm-shrinkwrap.json (the release lock) is missing: run pnpm release:lock");
  const lockBytes = fs.readFileSync(LOCK_FILE);
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const lockRoot = lock.packages?.[""] ?? {};
  if (lock.lockfileVersion !== 3 || lockRoot.name !== cli.name || lockRoot.version !== cli.version || JSON.stringify(lockRoot.dependencies ?? {}) !== JSON.stringify(sortedDeps)) {
    fail("apps/cli/npm-shrinkwrap.json does not match the package (name, version or dependencies): run pnpm release:lock");
  }
  const entries = Object.entries(lock.packages).filter(([k]) => k !== "").sort(([a], [b]) => byCodePoint(a, b));
  for (const [k, v] of entries) {
    if (!k.startsWith("node_modules/")) fail(`the release lock has a package outside node_modules: ${k}`);
    if (!String(v.resolved ?? "").startsWith(REGISTRY)) fail(`the release lock resolves ${k} outside ${REGISTRY}`);
    if (!/^sha512-/u.test(v.integrity ?? "")) fail(`the release lock has no sha512 integrity for ${k}`);
    // One tree for every platform, nothing run at install: no links, optional, dev, platform-specific or scripted packages.
    if (v.link || v.optional || v.dev || v.os !== undefined || v.cpu !== undefined || v.hasInstallScript) fail(`${k} is a link, optional, dev, platform-specific or has an install script`);
  }
  const overrides = readJson(path.join(ROOT, "scripts", "release", "license-overrides.json")).packages;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "duo-runtime-tree-"));
  try {
    fs.writeFileSync(path.join(work, "package.json"), `${JSON.stringify({ name: lockRoot.name, version: lockRoot.version, private: true, dependencies: lockRoot.dependencies }, null, 2)}\n`);
    fs.writeFileSync(path.join(work, "package-lock.json"), lockBytes);
    // Only the public registry and no user configuration (a mirror or token in ~/.npmrc must not shape the tree).
    fs.writeFileSync(path.join(work, ".npmrc"), `registry=${REGISTRY}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/iu.test(k)));
    const [npmBin, npmPrefix] = npmCommand();
    execFileSync(npmBin, [...npmPrefix, "ci", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund", "--registry", REGISTRY, "--userconfig", path.join(work, ".npmrc"), "--loglevel=error"], {
      cwd: work, env, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    });
    const installed = packageDirs(path.join(work, "node_modules"), "node_modules");
    const expected = entries.map(([k]) => k);
    if (JSON.stringify(installed) !== JSON.stringify(expected)) {
      fail(`npm ci did not install exactly the locked tree: missing ${expected.filter((k) => !installed.includes(k)).join(", ") || "none"}, extra ${installed.filter((k) => !expected.includes(k)).join(", ") || "none"}`);
    }
    for (const [k, v] of entries) {
      const dir = path.join(work, ...k.split("/"));
      const name = v.name ?? k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
      const meta = readJson(path.join(dir, "package.json"));
      if (meta.name !== name || meta.version !== v.version) fail(`${k}: installed ${meta.name}@${meta.version}, locked ${name}@${v.version}`);
      const override = overrides[`${name}@${v.version}`];
      const license = v.license ?? override?.license;
      if (typeof license !== "string" || license === "") fail(`${name}@${v.version} has no license in the release lock and no reviewed override (scripts/release/license-overrides.json)`);
      const files = packageFiles(dir);
      for (const f of files) {
        const target = path.join(STAGE, ...k.split("/"), ...f.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(dir, ...f.split("/")), target);
      }
      pending.push({ path: k, name, version: v.version, integrity: v.integrity, license, override, files });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

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
  // npm-packlist adds README, LICENSE, package.json and the bundled dependencies (node_modules/) by itself.
  files: ["dist"],
  engines: cli.engines,
  dependencies: sortedDeps,
  // H-65: every runtime dependency ships inside the package with its locked transitive tree (dist/runtime-tree.json).
  ...(pending.length === 0 ? {} : { bundleDependencies: Object.keys(sortedDeps) }),
  keywords: ["duo", "coding-agent", "mcp", "codex", "claude-code", "project-direction"],
  publishConfig: { access: "public" },
};
fs.writeFileSync(path.join(STAGE, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(ROOT, "apps/cli/README.md"), path.join(STAGE, "README.md"));
// The repository LICENSE ships unchanged; third-party licenses stay in dist/THIRD_PARTY_NOTICES.md and dist/grammars/.
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(STAGE, "LICENSE"));

const [npmBin, npmPrefix] = npmCommand();
// npm-packlist decides which files of a bundled package go into the tarball: the package's own "files" plus what npm
// always packs. A published package can hold more (which@2.0.2 has CHANGELOG.md outside its "files"). The runtime tree
// is what npm packs: a dry run first, the rest leaves the stage and is recorded per package (notPacked).
if (pending.length > 0) {
  const dry = JSON.parse(execFileSync(npmBin, [...npmPrefix, "pack", STAGE, "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8", windowsHide: true, cwd: OUT, maxBuffer: 256 * 1024 * 1024,
  }))[0];
  const willPack = new Set(dry.files.map((f) => f.path).filter((f) => f.startsWith("node_modules/")));
  const staged = new Set(pending.flatMap((p) => p.files.map((f) => `${p.path}/${f}`)));
  const unknown = [...willPack].filter((f) => !staged.has(f));
  if (unknown.length > 0) fail(`npm would pack node_modules files that are not in the runtime tree: ${unknown.slice(0, 5).join(", ")}`);
  const packages = [];
  for (const p of pending) {
    const kept = p.files.filter((f) => willPack.has(`${p.path}/${f}`));
    const notPacked = p.files.filter((f) => !willPack.has(`${p.path}/${f}`));
    for (const f of notPacked) fs.rmSync(path.join(STAGE, ...p.path.split("/"), ...f.split("/")));
    const abs = (f) => path.join(STAGE, ...p.path.split("/"), ...f.split("/"));
    const licenseFiles = kept.filter((f) => /^(licen[cs]e|copying|notice)([-_.][^/]*)?$/iu.test(f));
    if (licenseFiles.length === 0 && p.override === undefined) fail(`${p.name}@${p.version} ships no license file and has no reviewed override (scripts/release/license-overrides.json)`);
    bundledFiles.push(...kept.map((f) => `${p.path}/${f}`));
    const contentHash = sha256Text(kept.map((f) => `${f}\0${sha256(abs(f))}\n`).join(""));
    packages.push({ path: p.path, name: p.name, version: p.version, integrity: p.integrity, license: p.license, files: kept.length, contentHash, ...(notPacked.length > 0 ? { notPacked } : {}) });
    bundledNotices.push(`### ${p.name}@${p.version} (${p.license})`, "");
    if (licenseFiles.length === 0) bundledNotices.push(`No license file is included in the published package. License source: ${p.override.source}.`, "");
    for (const f of licenseFiles) bundledNotices.push(`${p.path}/${f}:`, "", "```text", fs.readFileSync(abs(f), "utf8").replaceAll("\r\n", "\n").trimEnd(), "```", "");
  }
  runtimeTree = {
    format: "duo.runtime-tree/1",
    package: `${cli.name}@${cli.version}`,
    delivery: "bundleDependencies",
    lock: { file: "apps/cli/npm-shrinkwrap.json", sha256: sha256(LOCK_FILE), registry: REGISTRY },
    packages,
    treeHash: sha256Text(packages.map((p) => `${p.path}\0${p.version}\0${p.contentHash}\n`).join("")),
  };
  fs.writeFileSync(path.join(STAGE, "dist", "runtime-tree.json"), `${JSON.stringify(runtimeTree, null, 2)}\n`);
}

// Third-party notices (Release Hardening). DUO's own license is separate (C164). Three kinds of third-party code:
// code bundled into dist/ui/app.js (its license texts, from the UI build), vendored grammar WASM (LICENSE-* files
// next to them) and the bundled npm runtime dependencies (node_modules/, each with its own license files, H-65).
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
  "## Bundled npm runtime dependencies (node_modules/)",
  "",
  "These packages are inside this package (bundleDependencies): the release lock installed from registry.npmjs.org, files unchanged, each package with its own license files in node_modules/. A file a package publishes outside its own \"files\" list is not packed by npm (listed as notPacked). Paths, versions, integrity and content hashes are in dist/runtime-tree.json.",
  "",
  ...(runtimeTree === undefined ? Object.entries(sortedDeps).map(([name, version]) => `- ${name}@${version}`).concat([""]) : bundledNotices),
];
fs.writeFileSync(path.join(STAGE, "dist", "THIRD_PARTY_NOTICES.md"), notices.join("\n"));

const packed = JSON.parse(execFileSync(npmBin, [...npmPrefix, "pack", STAGE, "--pack-destination", OUT, "--json", "--ignore-scripts"], {
  encoding: "utf8", windowsHide: true, cwd: OUT, maxBuffer: 256 * 1024 * 1024,
}))[0];
// The tarball holds exactly the runtime tree under node_modules/ (the files of the dry run, nothing more or less).
const packedTree = packed.files.map((f) => f.path).filter((f) => f.startsWith("node_modules/")).sort(byCodePoint);
if (JSON.stringify(packedTree) !== JSON.stringify([...bundledFiles].sort(byCodePoint))) {
  const want = new Set(bundledFiles);
  const got = new Set(packedTree);
  fail(`the packed node_modules/ differs from the runtime tree: missing ${bundledFiles.filter((f) => !got.has(f)).slice(0, 5).join(", ") || "none"}, extra ${packedTree.filter((f) => !want.has(f)).slice(0, 5).join(", ") || "none"}`);
}
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
  runtimeTree: runtimeTree === undefined ? null : { file: "dist/runtime-tree.json", delivery: runtimeTree.delivery, packages: runtimeTree.packages.length, files: bundledFiles.length, treeHash: runtimeTree.treeHash, lockSha256: runtimeTree.lock.sha256 },
};
fs.writeFileSync(path.join(OUT, "pack.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`pack-cli: ${packed.filename} · ${packed.size} bytes packed · ${packed.unpackedSize} bytes unpacked · ${packed.entryCount} files${runtimeTree === undefined ? "" : ` · ${runtimeTree.packages.length} bundled packages`}`);
