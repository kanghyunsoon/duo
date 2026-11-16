#!/usr/bin/env node
/**
 * CI (T131): the release conformance step reuses the tarball the distribution E2E step packed earlier in the same job,
 * instead of building and packing again. Before it does, this check confirms that .dist/pack.json and the tarball
 * agree: the file exists, its sha512 is the integrity npm pack reported, and the package name and version are this
 * checkout's. It also refuses a stale artifact: the working tree must be clean (no tracked change since the pack),
 * pack.commit must equal the checked-out HEAD, and pack.dirty must be false (the tree had no tracked change when it
 * was packed, #171; a pack.json without the field is refused). A fresh CI runner has no .dist/ of its own (it is
 * ignored by Git), so the tarball comes from this commit; the extra checks keep a reused local .dist/ from passing.
 *
 *   node scripts/ci/check-packed-artifact.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackedChanges } from "./tracked-changes.mjs";

const ROOT = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)));
const PACK = path.join(ROOT, ".dist", "pack.json");
const fail = (message) => {
  console.error(`check-packed-artifact: ${message}`);
  process.exit(1);
};

if (!fs.existsSync(PACK)) fail(".dist/pack.json is missing: run pnpm test:dist (or node scripts/pack-cli.mjs) first");
const pack = JSON.parse(fs.readFileSync(PACK, "utf8"));
if (typeof pack.tarball !== "string" || !fs.existsSync(pack.tarball)) fail(`the packed tarball ${String(pack.tarball)} is missing`);
const bytes = fs.readFileSync(pack.tarball);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
if (integrity !== pack.integrity) fail(`${path.basename(pack.tarball)} does not match .dist/pack.json (integrity ${integrity}, recorded ${String(pack.integrity)})`);
const cli = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "cli", "package.json"), "utf8"));
if (pack.name !== cli.name) fail(`.dist/pack.json is package ${String(pack.name)}, this checkout is ${cli.name}`);
if (pack.version !== cli.version) fail(`.dist/pack.json is version ${String(pack.version)}, this checkout is ${cli.version}`);
const changes = trackedChanges(ROOT);
if (changes.length > 0) fail(`the working tree has tracked changes, so the packed tarball may not be this commit: ${changes.slice(0, 5).join(", ")}`);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
if (typeof pack.commit !== "string" || pack.commit === "") fail(".dist/pack.json has no commit; pack again");
if (pack.commit !== head) fail(`.dist/pack.json is from commit ${pack.commit}, this checkout is ${head}; pack again`);
if (pack.dirty !== false) {
  fail(pack.dirty === true
    ? ".dist/pack.json was packed from a working tree with tracked changes, so the tarball may not be this commit; pack again"
    : ".dist/pack.json does not record whether the tree was clean when it was packed; pack again");
}
console.log(`check-packed-artifact: reusing ${path.basename(pack.tarball)} · ${bytes.length} bytes · sha256 ${createHash("sha256").update(bytes).digest("hex")} · ${integrity}`);
