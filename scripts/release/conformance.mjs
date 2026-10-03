#!/usr/bin/env node
/**
 * pnpm test:conformance — TASK-020 release conformance against the installed release candidate.
 *   1. install the packed tarball into an isolated npm prefix (no workspace, pnpm or NODE_PATH)
 *   2. the installed runtime tree equals the one the package carries (dist/runtime-tree.json, H-65); THIRD_PARTY_NOTICES.md
 *      covers the UI bundle and every bundled npm package
 *   3. C209 targeted reproduction (installed duoctl init, --runs N)
 *   4. the subprocess journeys + RC-only checks (vitest.conformance.config.ts) with DUO_CONFORMANCE_CLI
 *   5. README / 07-cli-interface.md commands and options against the installed duoctl --help; old-design phrases
 *   → .dist/release-conformance.json (duo.release-conformance/1). Publishes nothing.
 *
 *   node scripts/release/conformance.mjs [--runs 20] [--skip-e2e]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareInstalledTree, DIST, gitState, npm, readJson, ROOT, run } from "./common.mjs";

const args = process.argv.slice(2);
// CI sets DUO_C209_RUNS (a shorter targeted smoke per OS); the reference environment uses 20.
const runs = Number(args.includes("--runs") ? args[args.indexOf("--runs") + 1] : process.env.DUO_C209_RUNS ?? "20");
const skipE2e = args.includes("--skip-e2e");
const IS_WIN = process.platform === "win32";
const log = (m) => console.log("conformance: " + m);
const problems = [];

// ---- 1. the artifact ----
if (!fs.existsSync(path.join(DIST, "pack.json"))) {
  const p = run(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs")]);
  if (p.code !== 0) { console.error(p.stdout + p.stderr); process.exit(2); }
}
const pack = readJson(path.join(DIST, "pack.json"));
const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-conformance-")));
const isolated = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_PATH|NODE_OPTIONS|npm_.*|PNPM.*|VITEST.*)$/iu.test(k)));
log("installing " + path.basename(pack.tarball) + " into an isolated prefix");
const inst = npm(["install", "-g", "--prefix", prefix, pack.tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: prefix, env: isolated });
if (inst.code !== 0) { console.error(inst.stderr); process.exit(2); }
const pkgDir = path.join(prefix, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli");
const entry = path.join(pkgDir, "dist", "duoctl.js");

// ---- 2. runtime tree and notices ----
const tree = compareInstalledTree(pkgDir, path.dirname(path.dirname(pkgDir)));
const treeMismatch = [...tree.mismatches, ...tree.extra.map((d) => d + ": not in the runtime tree"), ...tree.outside.map((d) => d + ": installed outside the package")];
if (treeMismatch.length > 0) problems.push("installed tree differs from dist/runtime-tree.json: " + treeMismatch.slice(0, 20).join(", "));
const notices = fs.readFileSync(path.join(pkgDir, "dist", "THIRD_PARTY_NOTICES.md"), "utf8");
const noticePackages = ["react", "react-dom", "scheduler"].filter((n) => new RegExp("### " + n + "@\\d").test(notices));
if (noticePackages.length !== 3) problems.push("THIRD_PARTY_NOTICES.md misses a UI bundle package");
const runtimeTree = readJson(path.join(pkgDir, "dist", "runtime-tree.json"));
const withoutNotice = runtimeTree.packages.filter((p) => !notices.includes("### " + p.name + "@" + p.version + " (")).map((p) => p.name + "@" + p.version);
if (withoutNotice.length > 0) problems.push("THIRD_PARTY_NOTICES.md misses bundled packages: " + withoutNotice.join(", "));
const artifact = { tarball: path.basename(pack.tarball), size: pack.size, unpackedSize: pack.unpackedSize, entryCount: pack.entryCount, integrity: pack.integrity,
  runtimeTree: { packages: tree.packages, treeHash: tree.treeHash, installedTreeMatches: treeMismatch.length === 0, outside: tree.outside.length }, notices: noticePackages, bundledNotices: runtimeTree.packages.length - withoutNotice.length };
log("runtime tree " + artifact.runtimeTree.packages + " packages, installed tree " + (treeMismatch.length === 0 ? "matches" : "DIFFERS") + "; notices " + noticePackages.join(", ") + " + " + artifact.bundledNotices + " bundled");

// ---- 3. C209 ----
log("C209: " + runs + " installed duoctl init runs");
const repro = run(process.execPath, [path.join(ROOT, "scripts", "release", "init-repro.mjs"), "--prefix", prefix, "--runs", String(runs)], { env: isolated });
let c209;
try { c209 = JSON.parse(repro.stdout.trim().split(/\r?\n/u).at(-1)); } catch { c209 = { error: (repro.stderr || repro.stdout).slice(0, 500) }; }
if (repro.code !== 0) problems.push("C209 reproduction: " + (c209.failures ?? "?") + " failing run(s), " + (c209.anomalies ?? "?") + " empty-stdout anomalies");
log("C209: anomalies " + c209.anomalies + ", failures " + c209.failures + " of " + c209.runs);

// ---- 4. journeys against the installed RC ----
let e2e = { skipped: true };
if (!skipE2e) {
  const out = path.join(DIST, "conformance-vitest.json");
  fs.rmSync(out, { force: true });
  log("running the conformance suite against " + entry);
  const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const v = run(process.execPath, [vitest, "run", "--config", "vitest.conformance.config.ts", "--reporter=default", "--reporter=json", "--outputFile=" + out],
    { env: { ...process.env, DUO_CONFORMANCE_CLI: entry, DUO_CONFORMANCE_PREFIX: prefix } });
  fs.writeFileSync(path.join(DIST, "conformance-vitest.log"), v.stdout + "\n" + v.stderr);
  const j = fs.existsSync(out) ? readJson(out) : undefined;
  const tests = (j?.testResults ?? []).flatMap((f) => f.assertionResults.map((a) => ({ file: path.relative(ROOT, f.name).replaceAll("\\", "/"), name: a.fullName, status: a.status })));
  e2e = { ok: v.code === 0, files: j?.numTotalTestSuites ?? null, passed: j?.numPassedTests ?? 0, failed: j?.numFailedTests ?? 0, skipped: j?.numPendingTests ?? 0, ms: v.ms, tests };
  if (v.code !== 0) problems.push("conformance suite failed: " + e2e.failed + " test(s)");
  log("suite: " + e2e.passed + " passed, " + e2e.failed + " failed, " + e2e.skipped + " skipped");
}

// ---- 5. documentation against the installed CLI ----
const help = run(process.execPath, [entry, "--help"], { env: isolated }).stdout;
const helpCommands = new Set([...help.matchAll(/^ {2}([a-z]+) {2,}/gmu)].map((m) => m[1]));
const docs = {};
for (const file of ["README.md", "apps/cli/README.md", "docs/07-cli-interface.md"]) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const used = [...new Set([...text.matchAll(/\bduoctl ([a-z][a-z-]*)/gu)].map((m) => m[1]))].filter((c) => !["is", "the", "on", "and", "or", "binary", "executable", "in"].includes(c));
  const missing = used.filter((c) => !helpCommands.has(c));
  const flags = [...new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]+)/gu)].map((m) => m[1]))];
  // npm/pnpm flags in install instructions, and T00 draft flags the documents explicitly mark as not implemented.
  const NOT_DUOCTL = ["frozen-lockfile", "no-install", "prefix", "global", "save-dev", "dry-run", "access", "registry", "tag", "ignore-scripts"];
  const DOCUMENTED_AS_ABSENT = ["run-tests", "no-llm", "reindex"];
  const missingFlags = flags.filter((f) => !help.includes("--" + f) && !NOT_DUOCTL.includes(f) && !DOCUMENTED_AS_ABSENT.includes(f));
  docs[file] = { commands: used, missingCommands: missing, flags, flagsNotInHelp: missingFlags };
}
if (!help.includes("--semantic")) problems.push("duoctl --help does not mention --semantic");
for (const [f, d] of Object.entries(docs)) if (d.missingCommands.length > 0) problems.push(f + " uses duoctl commands the RC does not have: " + d.missingCommands.join(", "));
const OLD = [
  ["default M1 auto-created", /기본(?:으로)?\s*M1[^.\n]*자동\s*생성|creates? (?:a )?default M1/iu],
  ["Constraint auto-inferred", /Constraint[^.\n]*자동\s*(?:추론|생성)/iu],
  ["TS/JS only", /TS\/JS only|TypeScript\/JavaScript만 (?:지원|분석)/iu],
  ["LLM required", /LLM(?:이|은)? (?:필요합니다|필수)|requires? an? (?:LLM|API key) to/iu],
  ["MCP confirm/reject", /MCP[^.\n]*(?:confirm|reject)[^.\n]*(?:tool|Tool)(?![^.\n]*(?:없|not|no\b|never|금지))/u],
  ["auto index on context/review", /(?:context|review)[^.\n]*자동(?:으로)?\s*(?:index|인덱싱)/iu],
  ["global Codex config modification", /global[^.\n]*config[^.\n]*(?:수정합니다|modif(?:y|ies)\b)(?![^.\n]*(?:않|not|never|금지))/iu],
];
const docFiles = ["README.md", ...fs.readdirSync(path.join(ROOT, "docs"), { recursive: true }).filter((f) => String(f).endsWith(".md")).map((f) => "docs/" + String(f).replaceAll("\\", "/"))]
  .filter((f) => f !== "docs/conflicts.md" && !f.startsWith("docs/references/"));
const oldDesign = [];
for (const f of docFiles) {
  const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/u);
  // A line that states the old design only to deny it ("자동으로 index하지 않고", "no confirm tool") is current, not old.
  const denies = /않|없|금지|두지 않|not\b|never|no\b|without/iu;
  lines.forEach((line, i) => { for (const [id, re] of OLD) if (re.test(line) && !denies.test(line)) oldDesign.push({ file: f, line: i + 1, id, text: line.trim().slice(0, 160) }); });
}
docs.oldDesign = oldDesign;
for (const [f, d] of Object.entries(docs)) if (f !== "oldDesign" && d.flagsNotInHelp.length > 0) problems.push(f + " documents options duoctl --help does not list: " + d.flagsNotInHelp.join(", "));
if (oldDesign.length > 0) problems.push("old-design wording in the documentation: " + oldDesign.map((o) => o.file + ":" + o.line + " (" + o.id + ")").join(", "));
log("docs: " + Object.entries(docs).filter(([k]) => k !== "oldDesign").map(([k, d]) => k + " missing " + d.missingCommands.length).join(", ") + "; old-design matches " + oldDesign.length);

const git = gitState();
const preflightFile = path.join(DIST, "release-preflight.json");
const preflight = fs.existsSync(preflightFile) ? readJson(preflightFile) : undefined;
const report = {
  format: "duo.release-conformance/1",
  version: readJson(path.join(ROOT, "apps", "cli", "package.json")).version,
  git: { commit: git.commit, branch: git.branch, clean: git.clean },
  os: process.platform, node: process.version,
  artifact, c209, e2e, docs,
  problems,
  blockers: preflight?.git?.commit === git.commit ? preflight.blockers : "run pnpm release:preflight on this commit",
  deferred: preflight?.deferred ?? [],
};
fs.writeFileSync(path.join(DIST, "release-conformance.json"), JSON.stringify(report, null, 2) + "\n");
fs.rmSync(prefix, { recursive: true, force: true });
log(problems.length === 0 ? "OK" : problems.length + " problem(s):");
for (const p of problems) console.log("  - " + p);
process.exit(problems.length === 0 ? 0 : 1);
