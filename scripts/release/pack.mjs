#!/usr/bin/env node
/**
 * pnpm release:pack — the release candidate tarball from the current commit (Release Hardening §31–34).
 * Refuses a dirty working tree (uncommitted code would ship under a commit that does not contain it);
 * DUO_RELEASE_ALLOW_DIRTY=1 allows it explicitly and records clean: false. Build → pack-cli →
 * .dist/release-candidate.json (commit, branch, clean, version, tarball, hashes). Publishes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { DIST, gitState, pnpm, readJson, ROOT, run, stagedFiles } from "./common.mjs";

const git = gitState();
if (!git.clean && process.env.DUO_RELEASE_ALLOW_DIRTY !== "1") {
  console.error(`release:pack: the working tree is not clean (${git.changes.length} change(s)); commit first, or set DUO_RELEASE_ALLOW_DIRTY=1 for a test artifact`);
  for (const c of git.changes.slice(0, 20)) console.error(`  ${c}`);
  process.exit(1);
}
const build = pnpm(["build"]);
if (build.code !== 0) { console.error(build.stdout + build.stderr); process.exit(1); }
const packed = run(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs")]);
if (packed.code !== 0) { console.error(packed.stdout + packed.stderr); process.exit(1); }
const pack = readJson(path.join(DIST, "pack.json"));
const stage = path.join(DIST, "cli-package");
const manifest = readJson(path.join(stage, "package.json"));
// H-65: the runtime dependency tree travels inside the package (bundleDependencies), recorded in dist/runtime-tree.json.
const tree = readJson(path.join(stage, "dist", "runtime-tree.json"));
const summary = {
  format: "duo.release-candidate/2",
  name: manifest.name, version: manifest.version,
  git: { commit: git.commit, branch: git.branch, clean: git.clean },
  tarball: path.basename(pack.tarball), size: pack.size, unpackedSize: pack.unpackedSize, entryCount: pack.entryCount, integrity: pack.integrity,
  files: stagedFiles(stage),
  dependencies: manifest.dependencies,
  runtimeTree: { file: "dist/runtime-tree.json", delivery: tree.delivery, bundleDependencies: manifest.bundleDependencies ?? null, packages: tree.packages.length, treeHash: tree.treeHash, lockSha256: tree.lock.sha256 },
};
fs.writeFileSync(path.join(DIST, "release-candidate.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`release:pack: ${summary.tarball} · ${summary.size} B · ${summary.entryCount} files · commit ${git.commit.slice(0, 12)}${git.clean ? "" : " (DIRTY)"}`);
