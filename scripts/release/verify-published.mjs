#!/usr/bin/env node
/**
 * pnpm release:verify-published — checks a version that a human already published (T21-B).
 * The pre-publish counterpart is pnpm release:preflight. This script never publishes, tags, logs in or creates a
 * GitHub Release; it reads the npm registry and GitHub, installs the published package into a temporary prefix
 * with an empty npm config and its own cache (no credentials are read or needed), and runs the installed duoctl.
 * Network is required, so it is not part of pnpm verify or CI.
 *
 *   pnpm release:verify-published [--version 0.1.0] [--integrity sha512-…] [--commit <sha>]
 *     → .dist/release-published.json, exit 1 while a check fails
 *
 * Expected integrity and commit: the flags, else .dist/release-candidate.json when it is for the same version.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelPolicy, publishedChannelProblems } from "./channel.mjs";
import { compareInstalledTree, DIST, npm, readJson, REGISTRY, ROOT, run } from "./common.mjs";

const flag = (name) => { const i = process.argv.indexOf("--" + name); return i < 0 ? undefined : process.argv[i + 1]; };
const cliManifest = readJson(path.join(ROOT, "apps", "cli", "package.json"));
const name = cliManifest.name;
const version = flag("version") ?? cliManifest.version;
const candidateFile = path.join(DIST, "release-candidate.json");
const candidate = fs.existsSync(candidateFile) ? readJson(candidateFile) : undefined;
const sameVersion = candidate?.version === version;
const expected = {
  integrity: flag("integrity") ?? (sameVersion ? candidate.integrity : undefined),
  commit: flag("commit") ?? (sameVersion ? candidate.git?.commit : undefined),
  source: flag("integrity") !== undefined ? "flag" : sameVersion ? ".dist/release-candidate.json" : "none",
};
const problems = [];
const problem = (id, message) => problems.push({ id, message });
const log = (m) => console.log("release:verify-published: " + m);
const IS_WIN = process.platform === "win32";

// An isolated npm: empty user config, its own cache and prefix, the public registry only.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-published-")));
const userconfig = path.join(tmp, "npmrc");
fs.writeFileSync(userconfig, "");
const isolated = ["--userconfig", userconfig, "--cache", path.join(tmp, "cache"), "--registry", REGISTRY];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|NPM_|NODE_OPTIONS$|NODE_PATH$)/u.test(k)));

let report;
try {
  // ---- registry ----
  log("registry " + name + "@" + version);
  const view = npm(["view", name + "@" + version, "--json", ...isolated], { env });
  let meta;
  try { meta = view.code === 0 ? JSON.parse(view.stdout) : undefined; } catch { meta = undefined; }
  const registry = meta === undefined ? { published: false } : {
    published: meta.version === version, name: meta.name, version: meta.version, license: meta.license, engines: meta.engines, bin: meta.bin,
    integrity: meta.dist?.integrity, tarball: meta.dist?.tarball, fileCount: meta.dist?.fileCount, unpackedSize: meta.dist?.unpackedSize,
    latest: meta["dist-tags"]?.latest, distTags: meta["dist-tags"] ?? {}, repository: meta.repository?.url, homepage: meta.homepage,
  };
  if (!registry.published) problem("not-published", name + "@" + version + " is not in " + REGISTRY);
  if (registry.published) {
    if (registry.name !== name) problem("name", "registry name " + registry.name);
    if (!String(registry.tarball ?? "").startsWith(REGISTRY)) problem("tarball-url", "tarball is not served by " + REGISTRY);
    if (expected.integrity !== undefined && registry.integrity !== expected.integrity) problem("integrity", "registry integrity differs from the approved release candidate");
    if (registry.license !== cliManifest.license) problem("license", "registry license " + registry.license + ", repository " + cliManifest.license);
    if (registry.engines?.node !== cliManifest.engines?.node) problem("engines", "registry engines.node " + registry.engines?.node);
    if (registry.bin?.duoctl === undefined) problem("bin", "no duoctl bin in the published metadata");
  }

  // ---- clean install into a temporary prefix ----
  let install = { ok: false };
  if (registry.published) {
    log("npm install -g (temporary prefix, empty npm config, fresh cache)");
    const prefix = path.join(tmp, "prefix");
    const r = npm(["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", name + "@" + version, ...isolated], { env });
    const pkgDir = IS_WIN ? path.join(prefix, "node_modules", ...name.split("/")) : path.join(prefix, "lib", "node_modules", ...name.split("/"));
    const shim = IS_WIN ? path.join(prefix, "duoctl.cmd") : path.join(prefix, "bin", "duoctl");
    install = { ok: r.code === 0 && fs.existsSync(pkgDir) && fs.existsSync(shim), ms: r.ms, ...(r.code === 0 ? {} : { tail: (r.stderr || r.stdout).slice(-600) }) };
    if (!install.ok) problem("install", "npm install -g of the published package failed");
    if (install.ok) {
      const installed = readJson(path.join(pkgDir, "package.json"));
      // The package's files as the tarball held them: bundled dependencies (node_modules/, H-65) included, the bin links
      // npm creates for them (node_modules/.bin) excluded.
      const files = fs.readdirSync(pkgDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !path.relative(pkgDir, e.parentPath).split(path.sep).some((s, i, all) => s === ".bin" && all[i - 1] === "node_modules"));
      const hasRuntimeTree = fs.existsSync(path.join(pkgDir, "dist", "runtime-tree.json"));
      install.package = { name: installed.name, version: installed.version, license: installed.license, files: installed.files, fileCount: files.length, hasLicense: fs.existsSync(path.join(pkgDir, "LICENSE")), hasRuntimeTree, hasShrinkwrap: fs.existsSync(path.join(pkgDir, "npm-shrinkwrap.json")) };
      if (installed.name !== name || installed.version !== version) problem("installed-version", "installed " + installed.name + "@" + installed.version);
      if (registry.fileCount !== undefined && files.length !== registry.fileCount) problem("installed-files", "installed " + files.length + " files, registry lists " + registry.fileCount);
      // 0.2.1 and later carry their runtime tree (H-65): the installed tree must be exactly it. Earlier versions pinned
      // the tree with npm-shrinkwrap.json (C163), which is only checked for presence here.
      if (hasRuntimeTree) {
        const tree = compareInstalledTree(pkgDir, path.dirname(path.dirname(pkgDir)));
        install.runtimeTree = { packages: tree.packages, treeHash: tree.treeHash, mismatches: tree.mismatches, extra: tree.extra, outside: tree.outside };
        if (tree.mismatches.length + tree.extra.length + tree.outside.length > 0) problem("runtime-tree", "the installed dependency tree differs from dist/runtime-tree.json: " + [...tree.mismatches, ...tree.extra, ...tree.outside].slice(0, 10).join(", "));
      }
      if (!install.package.hasLicense || !(hasRuntimeTree || install.package.hasShrinkwrap)) problem("installed-contents", "LICENSE or the runtime tree (dist/runtime-tree.json; npm-shrinkwrap.json before 0.2.1) missing from the installed package");

      // ---- the installed executable, found on PATH as a user's shell would ----
      const pathEnv = { ...env, PATH: [path.dirname(shim), path.dirname(process.execPath), ...String(env.PATH ?? env.Path ?? "").split(path.delimiter)].join(path.delimiter), DUO_LOCALE: "" };
      if (IS_WIN) delete pathEnv.Path;
      const duoctl = (args, cwd, input = "") => IS_WIN
        ? run("duoctl " + args.join(" "), [], { cwd, env: pathEnv, input, shell: true })
        : run("duoctl", args, { cwd, env: pathEnv, input });
      const v = duoctl(["--version"], tmp);
      const vj = duoctl(["--version", "--json"], tmp);
      let versionJson;
      try { versionJson = JSON.parse(vj.stdout); } catch { versionJson = undefined; }
      const help = duoctl(["--help"], tmp);
      // A fresh Git repository with one commit: init, then status (the first steps of the README).
      const repo = path.join(tmp, "repo");
      fs.mkdirSync(repo);
      const git = (...a) => run("git", ["-c", "user.name=DUO", "-c", "user.email=duo@duo.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo });
      git("-c", "init.defaultBranch=main", "init", "-q");
      fs.writeFileSync(path.join(repo, "index.js"), "export const answer = 42;\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      const init = duoctl(["init", "--non-interactive", "--answers", "-", "--json"], repo, "[]");
      const status = duoctl(["status", "--json"], repo);
      let statusJson;
      try { statusJson = JSON.parse(status.stdout).result; } catch { statusJson = undefined; }
      // Same contract as the distribution E2E: "duoctl <version>", and --version --json { name, version, schema versions }.
      install.executable = {
        version: v.stdout.trim(), versionOk: v.code === 0 && v.stdout.trim() === "duoctl " + version && versionJson?.name === "duoctl" && versionJson?.version === version,
        versionJson: versionJson === undefined ? null : { name: versionJson.name, version: versionJson.version, graphSchemaVersion: versionJson.graphSchemaVersion, projectSchemaVersions: versionJson.projectSchemaVersions },
        help: help.code === 0 && /duoctl/u.test(help.stdout),
        init: init.code, status: status.code, initialized: statusJson?.initialized ?? null, index: statusJson?.index?.status ?? null, llm: statusJson?.llm ?? null,
      };
      if (!install.executable.versionOk) problem("duoctl-version", "duoctl --version printed " + JSON.stringify(v.stdout.trim()) + " (exit " + v.code + ")");
      if (!install.executable.help) problem("duoctl-help", "duoctl --help failed");
      if (init.code !== 0 || statusJson?.initialized !== true || statusJson?.index?.status !== "current") problem("duoctl-journey", "init/status in a fresh repository did not give an initialized project with a current index");
    }
  }

  // ---- Git tag and GitHub Release (read only) ----
  const tag = "v" + version;
  const remoteTag = run("git", ["ls-remote", "--tags", "origin", "refs/tags/" + tag + "^{}", "refs/tags/" + tag]);
  const lines = remoteTag.stdout.trim().split(/\r?\n/u).filter(Boolean).map((l) => l.split(/\s+/u));
  const peeled = lines.find(([, ref]) => ref.endsWith("^{}"))?.[0] ?? lines[0]?.[0];
  const git = { tag, remoteCommit: peeled ?? null, expectedCommit: expected.commit ?? null };
  if (peeled === undefined) problem("git-tag", tag + " is not on origin");
  else if (expected.commit !== undefined && peeled !== expected.commit) problem("git-tag-commit", tag + " points to " + peeled.slice(0, 12) + ", the approved release candidate is " + expected.commit.slice(0, 12));
  const rel = run("gh", ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,publishedAt,url"]);
  let release;
  try { release = rel.code === 0 ? JSON.parse(rel.stdout) : undefined; } catch { release = undefined; }
  const githubRelease = release === undefined ? { exists: false } : { exists: true, draft: release.isDraft, prerelease: release.isPrerelease, publishedAt: release.publishedAt, url: release.url };
  if (!githubRelease.exists) problem("github-release", "no GitHub Release for " + tag);
  else if (githubRelease.draft) problem("github-release-draft", "the GitHub Release for " + tag + " is still a draft");

  // ---- release channel (H-70, T43.1): stable → latest and a stable GitHub Release; prerelease → next, latest stays stable, a prerelease GitHub Release ----
  const policy = channelPolicy(version);
  const channel = { releaseChannel: policy?.releaseChannel ?? null, expectedDistTag: policy?.expectedDistTag ?? null, distTags: registry.distTags ?? null, githubPrerelease: policy?.githubPrerelease ?? null };
  if (registry.published) for (const p of publishedChannelProblems({ version, distTags: registry.distTags, githubRelease })) problem(p.id, p.message);

  report = { format: "duo.release-published/1", name, version, expected, registry, install, git, githubRelease, channel, problems, ok: problems.length === 0 };
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "release-published.json"), JSON.stringify(report, null, 2) + "\n");
log((report.ok ? "OK" : "PROBLEMS") + " · " + name + "@" + version);
for (const p of problems) console.log("  - [" + p.id + "] " + p.message);
process.exit(report.ok ? 0 : 1);

