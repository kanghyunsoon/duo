#!/usr/bin/env node
/**
 * CI (T131): the release conformance step reuses the tarball the distribution E2E step packed earlier in the same job,
 * instead of building and packing again. Before it does, this check confirms that .dist/pack.json and the tarball
 * agree: the file exists, its sha512 is the integrity npm pack reported, and the package version is this checkout's.
 * A fresh CI runner has no .dist/ of its own (it is ignored by Git), so the tarball comes from this commit.
 *
 *   node scripts/ci/check-packed-artifact.mjs
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
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
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "cli", "package.json"), "utf8")).version;
if (pack.version !== version) fail(`.dist/pack.json is version ${String(pack.version)}, this checkout is ${version}`);
console.log(`check-packed-artifact: reusing ${path.basename(pack.tarball)} · ${bytes.length} bytes · sha256 ${createHash("sha256").update(bytes).digest("hex")} · ${integrity}`);
