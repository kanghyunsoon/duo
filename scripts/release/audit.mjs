#!/usr/bin/env node
/**
 * pnpm release:audit — network checks of the shipped dependency tree (Release Hardening §16–17; H-65). Two views:
 *   source:   the release lock apps/cli/npm-shrinkwrap.json as-is (npm audit with registry advisories, deprecation of
 *             each package in registry.npmjs.org);
 *   artifact: the runtime tree the packed package carries (.dist/cli-package/dist/runtime-tree.json, when packed). The
 *             bundled packages are audited through the lock, so the artifact view checks that they are the same
 *             packages (path, version, integrity); a difference is a problem.
 * Separate from the offline CI; DUO's runtime never needs it. Writes .dist/release-audit.json. Exit 1 on a
 * high/critical advisory, a deprecated package, an unavailable registry or an artifact tree that is not the lock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST, npm, readJson, REGISTRY, ROOT } from "./common.mjs";

const lock = readJson(path.join(ROOT, "apps", "cli", "npm-shrinkwrap.json"));
const treeFile = path.join(DIST, "cli-package", "dist", "runtime-tree.json");
const lockTree = Object.entries(lock.packages).filter(([k]) => k !== "").sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.version, v.integrity]);
const artifact = fs.existsSync(treeFile)
  ? (() => { const t = readJson(treeFile); const same = JSON.stringify(t.packages.map((p) => [p.path, p.version, p.integrity])) === JSON.stringify(lockTree); return { packed: true, package: t.package, packages: t.packages.length, treeHash: t.treeHash, sameAsLock: same }; })()
  : { packed: false, note: "no packed runtime tree (run node scripts/pack-cli.mjs); only the source lock was audited" };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "duo-release-audit-"));
let report;
try {
  const root = lock.packages[""];
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: root.name, version: root.version, dependencies: root.dependencies }));
  fs.writeFileSync(path.join(work, "package-lock.json"), JSON.stringify(lock));
  fs.writeFileSync(path.join(work, ".npmrc"), `registry=${REGISTRY}\n`);
  const audit = npm(["audit", "--json", "--package-lock-only", "--registry", REGISTRY, "--userconfig", path.join(work, ".npmrc")], { cwd: work });
  let parsed;
  try { parsed = JSON.parse(audit.stdout); } catch { parsed = undefined; }
  const counts = parsed?.metadata?.vulnerabilities;
  const advisories = Object.values(parsed?.vulnerabilities ?? {}).map((v) => ({ name: v.name, severity: v.severity, range: v.range, fixAvailable: Boolean(v.fixAvailable) }));
  const entries = Object.entries(lock.packages).filter(([k]) => k !== "").map(([k, v]) => ({ name: v.name ?? k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length), version: v.version }));
  const unique = [...new Map(entries.map((e) => [`${e.name}@${e.version}`, e])).values()];
  const deprecated = [];
  const failures = [];
  for (let i = 0; i < unique.length; i += 12) {
    await Promise.all(unique.slice(i, i + 12).map(async (e) => {
      const res = await fetch(`${REGISTRY}${e.name.replace("/", "%2f")}/${e.version}`, { headers: { accept: "application/json" } }).catch((error) => ({ ok: false, status: String(error) }));
      if (!res.ok) { failures.push(`${e.name}@${e.version}: ${res.status}`); return; }
      const doc = await res.json();
      if (doc.deprecated) deprecated.push({ name: e.name, version: e.version, message: String(doc.deprecated).slice(0, 200) });
    }));
  }
  report = {
    format: "duo.release-audit/2", registry: REGISTRY, packages: unique.length,
    source: { file: "apps/cli/npm-shrinkwrap.json", packages: lockTree.length },
    artifact,
    audit: { ok: counts !== undefined, exitCode: audit.code, vulnerabilities: counts ?? null, advisories, error: counts === undefined ? (audit.stderr || audit.stdout).slice(0, 500) : undefined },
    deprecated, registryFailures: failures,
  };
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "release-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
const v = report.audit.vulnerabilities;
console.log(`release:audit: ${report.packages} packages · advisories ${v === null ? "unavailable" : JSON.stringify(v)} · deprecated ${report.deprecated.length} · registry failures ${report.registryFailures.length} · artifact ${artifact.packed ? (artifact.sameAsLock ? "= lock" : "DIFFERS from the lock") : "not packed"}`);
const serious = v !== null && (v.high ?? 0) + (v.critical ?? 0) > 0;
process.exit(!report.audit.ok || serious || report.deprecated.length > 0 || report.registryFailures.length > 0 || artifact.sameAsLock === false ? 1 : 0);
