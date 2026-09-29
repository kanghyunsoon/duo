#!/usr/bin/env node
/**
 * pnpm release:preflight — checks the release candidate and reports (Release Hardening §24–27, §32, §47–50).
 * Read/check/report only: it never changes a version, commits, tags, creates an npm scope or publishes.
 * Its last npm step is "npm publish --dry-run". Network sections (npm identity, registry, audit, public
 * repository) are part of this explicit command, never of pnpm verify.
 *
 *   pnpm release:preflight [--skip-tests]      → .dist/release-preflight.json, exit 1 while blockers remain
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST, gitState, npm, pnpm, readJson, REGISTRY, ROOT, run, stagedFiles } from "./common.mjs";

const skipTests = process.argv.includes("--skip-tests");
const blockers = [];
const block = (id, message) => blockers.push({ id, message });
const log = (m) => console.log("release:preflight: " + m);

// ---- git ----
const git = gitState();
const repoCli = readJson(path.join(ROOT, "apps", "cli", "package.json"));
if (!git.clean) block("git-dirty", "the working tree has uncommitted changes (" + git.changes.length + ")");
if (git.branch !== "main") block("git-branch", "release candidates are cut from main (current: " + git.branch + ")");
const upstream = run("git", ["rev-parse", "@{u}"]).stdout.trim();
const pushed = upstream === git.commit;
if (!pushed) block("git-not-pushed", "HEAD is not the pushed origin/main commit");
let ci = { status: "unknown" };
const runs = run("gh", ["run", "list", "--commit", git.commit, "--json", "databaseId,status,conclusion", "--limit", "5"]);
if (runs.code === 0) {
  const list = JSON.parse(runs.stdout || "[]");
  const done = list.find((r) => r.status === "completed");
  ci = { status: list.length === 0 ? "none" : done === undefined ? "in-progress" : done.conclusion, run: done?.databaseId ?? list[0]?.databaseId };
}
if (ci.status !== "success") block("ci-not-green", "no successful CI run (3 OS) for HEAD " + git.commit.slice(0, 12) + " (" + ci.status + ")");
log("git " + git.commit.slice(0, 12) + " " + git.branch + (git.clean ? " clean" : " DIRTY") + ", CI " + ci.status);

// ---- verification (§32) ----
const verification = {};
const step = (name, args) => {
  log("running pnpm " + args.join(" "));
  const r = pnpm(args);
  verification[name] = { ok: r.code === 0, ms: r.ms, ...(r.code === 0 ? {} : { tail: (r.stdout + r.stderr).split(/\r?\n/u).slice(-15).join("\n") }) };
  if (r.code !== 0) block("verification-" + name, "pnpm " + args.join(" ") + " failed");
};
if (skipTests) {
  block("verification-skipped", "--skip-tests: verify, grammar, UI/browser/security, benchmark smoke and distribution E2E were not run");
} else {
  step("verify", ["verify"]); // boundaries, lint, typecheck, build, all tests (incl. UI browser and security), docs
  step("grammars", ["test:grammars"]);
  step("benchmarkSmoke", ["benchmark:smoke"]);
  step("distribution", ["test:dist"]); // packs, then clean global/local install, MCP, UI, polyglot, llm off
}
const testedIntegrity = fs.existsSync(path.join(DIST, "pack.json")) ? readJson(path.join(DIST, "pack.json")).integrity : undefined;

// ---- release candidate (§31, §33) ----
log("release:pack");
const rc = run(process.execPath, [path.join(ROOT, "scripts", "release", "pack.mjs")], { env: { ...process.env, ...(git.clean ? {} : { DUO_RELEASE_ALLOW_DIRTY: "1" }) } });
if (rc.code !== 0) { console.error(rc.stdout + rc.stderr); process.exit(2); }
const candidate = readJson(path.join(DIST, "release-candidate.json"));
const stage = path.join(DIST, "cli-package");
const manifest = readJson(path.join(stage, "package.json"));
if (!skipTests && testedIntegrity !== candidate.integrity) block("rc-not-tested", "the release candidate differs from the tarball the distribution E2E installed");

// ---- reproducibility (§56): a second pack into a temporary directory ----
const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "duo-rc-repack-"));
let reproducibility;
try {
  const again = run(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs"), "--out", out2]);
  const second = again.code === 0 ? stagedFiles(path.join(out2, "cli-package")) : {};
  const p2 = again.code === 0 ? readJson(path.join(out2, "pack.json")) : {};
  const firstFiles = candidate.files;
  const differing = [...new Set([...Object.keys(firstFiles), ...Object.keys(second)])].filter((f) => firstFiles[f] !== second[f]);
  reproducibility = { ok: again.code === 0 && differing.length === 0 && p2.integrity === candidate.integrity, fileSetEqual: JSON.stringify(Object.keys(firstFiles)) === JSON.stringify(Object.keys(second)), differing, integrityEqual: p2.integrity === candidate.integrity };
} finally {
  fs.rmSync(out2, { recursive: true, force: true });
}
if (!reproducibility.ok) block("not-reproducible", "packing twice gave different contents: " + reproducibility.differing.join(", "));

// ---- package: metadata, allowlist, secrets, absolute paths (§52–55) ----
const pkg = { name: manifest.name, version: manifest.version, description: manifest.description, license: manifest.license, repository: manifest.repository, homepage: manifest.homepage, bugs: manifest.bugs, bin: manifest.bin, engines: manifest.engines, files: manifest.files, dependencies: manifest.dependencies, tarball: candidate.tarball, size: candidate.size, unpackedSize: candidate.unpackedSize, entryCount: candidate.entryCount, integrity: candidate.integrity };
for (const field of ["name", "version", "description", "license", "repository", "homepage", "bugs", "bin", "engines", "files", "dependencies"]) if (pkg[field] === undefined) block("metadata-" + field, "package.json has no " + field);
if (manifest.name !== "@duo-director/cli") block("package-name", "the package name must stay @duo-director/cli");
if (manifest.version !== repoCli.version) block("version-source", "the packed version differs from apps/cli/package.json");
const allow = /^(package\.json|npm-shrinkwrap\.json|README\.md|LICENSE|dist\/THIRD_PARTY_NOTICES\.md|dist\/duoctl\.js|dist\/cli-[A-Z0-9]+\.js|dist\/grammars\/(tree-sitter-[a-z_]+\.wasm|LICENSE-tree-sitter-[a-z-]+|grammars\.json)|dist\/ui\/(index\.html|app\.js|app\.css))$/u;
const unexpected = Object.keys(candidate.files).filter((f) => !allow.test(f));
if (unexpected.length > 0) block("allowlist", "files outside the allowlist: " + unexpected.join(", "));
const secretPatterns = [
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u], ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/u], ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36}\b/u],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/u], ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
];
const home = os.homedir();
const pathNeedles = [...new Set([ROOT, ROOT.replaceAll("\\", "/"), ROOT.replaceAll("\\", "\\\\"), home, home.replaceAll("\\", "/"), home.replaceAll("\\", "\\\\"), os.tmpdir(), os.tmpdir().replaceAll("\\", "/")])].filter((n) => n.length > 3);
const pathPatterns = [["windows-user-path", /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+/u], ["mac-user-path", /\/Users\/[a-z][A-Za-z0-9._-]*\//u], ["linux-home-path", /\/home\/[a-z][A-Za-z0-9._-]*\//u]];
const scan = { files: 0, secrets: [], absolutePaths: [] };
for (const f of Object.keys(candidate.files)) {
  const text = fs.readFileSync(path.join(stage, f)).toString("latin1"); // WASM too: strings inside binaries
  scan.files++;
  for (const [id, re] of secretPatterns) if (re.test(text)) scan.secrets.push(f + ": " + id);
  for (const needle of pathNeedles) if (text.includes(needle)) scan.absolutePaths.push(f + ": contains a local path of this machine");
  for (const [id, re] of pathPatterns) { const m = re.exec(text); if (m) scan.absolutePaths.push(f + ": " + id + " " + JSON.stringify(m[0])); }
}
if (scan.secrets.length > 0) block("secrets", "secret-like content: " + scan.secrets.join("; "));
if (scan.absolutePaths.length > 0) block("absolute-paths", "absolute paths in the package: " + scan.absolutePaths.join("; "));

// ---- dependencies (offline inventory from the shrinkwrap, §16) ----
const lock = readJson(path.join(stage, "npm-shrinkwrap.json"));
const overrides = readJson(path.join(ROOT, "scripts", "release", "license-overrides.json")).packages;
const entries = Object.entries(lock.packages).filter(([k]) => k !== "").map(([k, v]) => {
  const name = v.name ?? k.slice(k.lastIndexOf("node_modules/") + 13);
  const override = v.license === undefined ? overrides[name + "@" + v.version] : undefined;
  return { path: k, name, version: v.version, license: v.license ?? override?.license ?? null, licenseSource: v.license !== undefined ? "lockfile" : override !== undefined ? "reviewed-override" : "none", deprecated: v.deprecated ?? null, resolved: v.resolved };
});
const PERMISSIVE = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Python-2.0"]);
const licenseOk = (l) => typeof l === "string" && l.replace(/[()]/gu, "").split(/\s+OR\s+/u).some((x) => PERMISSIVE.has(x.trim()));
const dependencies = {
  direct: manifest.dependencies,
  packages: entries.length,
  byLicense: entries.reduce((m, e) => ({ ...m, [e.license ?? "UNKNOWN"]: (m[e.license ?? "UNKNOWN"] ?? 0) + 1 }), {}),
  nonPermissive: entries.filter((e) => !licenseOk(e.license)).map((e) => e.name + "@" + e.version + " (" + (e.license ?? "unknown") + ")"),
  deprecatedInLock: entries.filter((e) => e.deprecated).map((e) => e.name + "@" + e.version),
  foreignResolved: entries.filter((e) => !String(e.resolved ?? "").startsWith(REGISTRY)).map((e) => e.path),
  inventory: entries.map(({ name, version, license, licenseSource }) => ({ name, version, license, licenseSource })),
};
if (dependencies.nonPermissive.length > 0) block("dependency-licenses", "dependencies without a recognized permissive license: " + dependencies.nonPermissive.join(", "));
if (dependencies.deprecatedInLock.length > 0) block("deprecated-dependencies", dependencies.deprecatedInLock.join(", "));
if (dependencies.foreignResolved.length > 0) block("shrinkwrap-registry", "shrinkwrap resolves outside " + REGISTRY);
log("audit (network)");
const audit = run(process.execPath, [path.join(ROOT, "scripts", "release", "audit.mjs")]);
dependencies.audit = fs.existsSync(path.join(DIST, "release-audit.json")) ? readJson(path.join(DIST, "release-audit.json")) : { error: audit.stderr.slice(0, 300) };
if (audit.code !== 0) block("audit", "release:audit reported a problem (advisory high/critical, deprecated package, or registry unavailable)");

// ---- DUO license (C164, §18–22) ----
const hasLicenseFile = fs.existsSync(path.join(ROOT, "LICENSE"));
const license = { declared: manifest.license, licenseFile: hasLicenseFile, inPackage: Object.hasOwn(candidate.files, "LICENSE"), thirdPartyNotices: Object.hasOwn(candidate.files, "dist/THIRD_PARTY_NOTICES.md"), grammarLicenses: Object.keys(candidate.files).filter((f) => f.startsWith("dist/grammars/LICENSE-")).length };
if (manifest.license === "UNLICENSED" || !hasLicenseFile || !license.inPackage) block("license-not-selected", "DUO's own LICENSE is not selected (C164, docs/release/decision-packets.md DP-2)");
if (!license.thirdPartyNotices || license.grammarLicenses < 6) block("third-party-notices", "third-party notices or grammar licenses are missing from the package");

// ---- npm identity, registry, scope, availability (C168, §23–27, network) ----
const npmConfig = (key) => npm(["config", "get", key]).stdout.trim();
const npmState = { registry: npmConfig("registry"), scopeRegistry: npmConfig("@duo-director:registry"), publishRegistry: REGISTRY };
if (!/^https:\/\/registry\.npmjs\.org\/?$/u.test(npmState.registry)) block("npm-registry", "the npm registry is " + npmState.registry + ", not " + REGISTRY);
if (npmState.scopeRegistry !== "undefined" && npmState.scopeRegistry !== "" && !/^https:\/\/registry\.npmjs\.org\/?$/u.test(npmState.scopeRegistry)) block("npm-scope-registry", "@duo-director:registry points to " + npmState.scopeRegistry);
const who = npm(["whoami", "--registry", REGISTRY]);
npmState.user = who.code === 0 ? who.stdout.trim() : null;
if (npmState.user === null) block("npm-auth", "not logged in to " + REGISTRY + " (npm login); scope access cannot be verified");
const view = npm(["view", manifest.name + "@" + manifest.version, "version", "--registry", REGISTRY]);
npmState.versionPublished = view.code === 0 && view.stdout.trim() === manifest.version;
npmState.packageExists = npm(["view", manifest.name, "name", "--registry", REGISTRY]).code === 0;
if (npmState.versionPublished) block("version-taken", manifest.name + "@" + manifest.version + " already exists in the registry");
if (npmState.user !== null) {
  const access = npm(["access", "list", "packages", "@duo-director", "--json", "--registry", REGISTRY]);
  const orgs = npm(["org", "ls", "duo-director", "--json", "--registry", REGISTRY]);
  const role = orgs.code === 0 ? JSON.parse(orgs.stdout || "{}")[npmState.user] : undefined;
  npmState.scope = { org: orgs.code === 0 ? "member" : "not-accessible", role: role ?? null, packagesListed: access.code === 0 };
  if (role !== "owner" && role !== "admin" && role !== "developer") block("npm-scope-access", "the npm account " + npmState.user + " has no publish role in the duo-director organization");
} else {
  npmState.scope = { org: "unverified" };
  block("npm-scope-access", "@duo-director publish access not verified (C168, DP-3)");
}
const publicRepo = await fetch(String(manifest.homepage ?? "").replace(/#.*$/u, ""), { method: "HEAD", redirect: "follow" }).then((r) => r.status, (e) => String(e));
npmState.repositoryPublic = publicRepo === 200;
if (!npmState.repositoryPublic) block("repository-not-public", "package links point to " + manifest.homepage + ", which is not publicly reachable (HTTP " + publicRepo + ")");
log("npm publish --dry-run");
const dry = npm(["publish", path.join(DIST, candidate.tarball), "--dry-run", "--json", "--access", "public", "--tag", "latest", "--registry", REGISTRY, "--ignore-scripts"]);
let dryParsed;
try {
  const parsed = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("{")));
  dryParsed = parsed[manifest.name] ?? parsed; // npm 11: { "<name>": { id, files, … } }
} catch { dryParsed = undefined; }
const dryFiles = dryParsed?.files?.map((f) => f.path).sort() ?? [];
npmState.publishDryRun = { ok: dry.code === 0, id: dryParsed?.id ?? null, entryCount: dryParsed?.entryCount ?? null, filesMatchCandidate: JSON.stringify(dryFiles) === JSON.stringify(Object.keys(candidate.files).sort()), ...(dry.code === 0 ? {} : { tail: (dry.stderr || dry.stdout).slice(-600) }) };
if (!npmState.publishDryRun.ok || !npmState.publishDryRun.filesMatchCandidate) block("publish-dry-run", "npm publish --dry-run failed or listed other files than the release candidate");
if (!dryFiles.includes("npm-shrinkwrap.json")) block("shrinkwrap-not-packed", "npm-shrinkwrap.json is not inside the tarball npm would publish");

// ---- actual OpenAI smoke (§28–30) ----
const smokeFile = path.join(DIST, "openai-smoke.json");
const smoke = fs.existsSync(smokeFile) ? readJson(smokeFile) : undefined;
const openaiSmoke = smoke === undefined ? { status: "not-executed" } : { status: smoke.passed && smoke.commit === git.commit ? "passed" : smoke.passed ? "passed-on-other-commit" : "failed", commit: smoke.commit, model: smoke.model, checks: smoke.checks };
if (openaiSmoke.status !== "passed") block("openai-smoke", "real OpenAI provider smoke not yet executed on this commit (" + openaiSmoke.status + "): DUO_OPENAI_SMOKE=1 OPENAI_API_KEY=… DUO_OPENAI_SMOKE_MODEL=… pnpm test:openai-smoke");

const report = {
  format: "duo.release-preflight/1",
  version: manifest.version,
  git: { ...git, changes: undefined, pushed, ci },
  verification: skipTests ? { skipped: true } : verification,
  package: pkg, reproducibility, scan,
  dependencies, license, npm: npmState, openaiSmoke,
  blockers,
  deferred: ["C184 optional grammar packaging", "C185 custom analyzer capability persistence", "C197 gap semantic assist", "C198 public repository benchmark", "C202 further performance candidates", "L2 resolvers for Java, C#, C++, Python", "REQ-NFR-004 scope (DP-1, priority should)"],
  ready: blockers.length === 0,
};
fs.writeFileSync(path.join(DIST, "release-preflight.json"), JSON.stringify(report, null, 2) + "\n");
log(blockers.length === 0 ? "READY: no blockers" : blockers.length + " blocker(s):");
for (const b of blockers) console.log("  - [" + b.id + "] " + b.message);
process.exit(blockers.length === 0 ? 0 : 1);
