#!/usr/bin/env node
/**
 * pnpm release:upgrade — the upgrade journey from the published previous version to the release candidate (T28).
 * Installs the registry package (--from, default 0.2.0: the latest published version) and the packed RC (.dist/pack.json) into two isolated npm
 * prefixes. Four repositories (TypeScript, Python, C++, sparse Truth) are adopted and indexed by the old duoctl with
 * 0.1.x project.yaml variants (A no llm block, B provider none, C openai-responses without a key, D sparse Truth,
 * E existing adoption with history). Then the installed RC runs: --version, status, doctor, index,
 * status, context, review, install codex and claude-code with verify. Checked: Truth bytes unchanged, no re-init,
 * no re-adoption, no Truth migration, an out-of-date index reported as stale (never silently current) and one index
 * restores current; an index the RC reports current must be current (the next index parses nothing and writes
 * nothing: a packaging-only patch such as 0.2.1 keeps the analysis identity). Network: the old package from the
 * registry. Publishes nothing.
 *   node scripts/release/upgrade.mjs [--from 0.2.0] [--keep]   → .dist/release-upgrade.json (duo.release-upgrade/1)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST, gitState, npm, readJson, REGISTRY, ROOT, run } from "./common.mjs";

const args = process.argv.slice(2);
const FROM = args.includes("--from") ? args[args.indexOf("--from") + 1] : "0.2.0";
const KEEP = args.includes("--keep");
const IS_WIN = process.platform === "win32";
const log = (m) => console.log("upgrade: " + m);
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); return ok; };

if (!fs.existsSync(path.join(DIST, "pack.json"))) {
  const p = run(process.execPath, [path.join(ROOT, "scripts", "pack-cli.mjs")]);
  if (p.code !== 0) { console.error(p.stdout + p.stderr); process.exit(2); }
}
const pack = readJson(path.join(DIST, "pack.json"));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-upgrade-")));
// No workspace resolution, no provider credentials, no inherited npm/pnpm/vitest state.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_PATH|NODE_OPTIONS|npm_.*|PNPM.*|VITEST.*|OPENAI_.*|GMS_.*|ANTHROPIC_.*)$/iu.test(k)));
const install = (name, spec) => {
  const prefix = path.join(work, name);
  fs.mkdirSync(prefix);
  const r = npm(["install", "-g", "--prefix", prefix, spec, "--registry", REGISTRY, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: prefix, env });
  if (r.code !== 0) { console.error(r.stderr); process.exit(2); }
  const pkgDir = path.join(prefix, ...(IS_WIN ? [] : ["lib"]), "node_modules", "@duo-director", "cli");
  return { prefix, bin: IS_WIN ? prefix : path.join(prefix, "bin"), entry: path.join(pkgDir, "dist", "duoctl.js"), version: readJson(path.join(pkgDir, "package.json")).version };
};
log("installing @duo-director/cli@" + FROM + " (registry) and " + path.basename(pack.tarball));
const OLD = install("old", "@duo-director/cli@" + FROM);
const NEW = install("rc", pack.tarball);
check(OLD.version === FROM, "old package version " + OLD.version + " != " + FROM);
check(NEW.version === pack.version, "RC version " + NEW.version + " != " + pack.version);

const pathEnv = (bin) => {
  const out = {};
  let current = "";
  for (const [k, v] of Object.entries(env)) { if (k.toUpperCase() === "PATH") current = v ?? ""; else out[k] = v; }
  out.PATH = [bin, current].filter((x) => x !== "").join(path.delimiter);
  return out;
};
const duo = (cli, root, a, input) => {
  const r = run(process.execPath, [cli.entry, ...a], { cwd: root, input: input ?? "", env: pathEnv(cli.bin) });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
};
const gitEnv = { ...env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid",
  GIT_AUTHOR_DATE: "2025-03-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-03-01T00:00:00Z" };

const DECISION = (id, governs) => ["id: " + id, "title: Upgrade journey decision " + id, "kind: decision", "state: confirmed", "question: where", "answer: here", "owner: human",
  "governs:", ...governs, 'confirmed_at: "2026-09-27T00:00:00Z"', "confirmed_by: tester", ""].join("\n");
const SPEC = (id, title) => "# Spec\n\n## " + id + " " + title + "\n\n" + "`".repeat(3) + "duo\nstatus: planned\n" + "`".repeat(3) + "\n\n" + title + ".\n";
const LLM = {
  A: null,
  B: "llm:\n  provider: none\n",
  C: "llm:\n  provider: openai-responses\n  model: upgrade-journey-model\n",
};
const FIXTURES = [
  { id: "ts", language: "TypeScript/JavaScript", configs: ["A", "E"], llm: "A", target: "D-901", edit: ["src/scheduler.ts", "% 7", "% 6"],
    files: {
      "package.json": JSON.stringify({ name: "orbit", version: "1.0.0", type: "module" }) + "\n",
      "src/scheduler.ts": "import { step } from \"./step.js\";\n\nexport class Scheduler {\n  next(day: number): number {\n    return step(day) % 7;\n  }\n}\n",
      "src/step.ts": "export function step(input: number): number {\n  return input + 1;\n}\n",
      "src/reminder.ts": "import { Scheduler } from \"./scheduler.js\";\n\nexport function remind(day: number): string {\n  return \"member-\" + new Scheduler().next(day);\n}\n",
      "tests/scheduler.test.ts": "import { Scheduler } from \"../src/scheduler.js\";\n\nexport const ok = new Scheduler().next(1) < 7;\n",
    },
    truth: { ".duo-project/decisions/D-901.yaml": DECISION("D-901", ['  requirements: [ORBIT-01]', '  symbols: ["Scheduler.next"]']), ".duo-project/specs/orbit.md": SPEC("ORBIT-01", "Pick the next member fairly") },
    history: [["src/step.ts", "input + 1", "input + 2"], ["src/reminder.ts", "\"member-\"", "\"person-\""]] },
  { id: "python", language: "Python", configs: ["B"], llm: "B", target: "D-902", edit: ["src/billing/core.py", "* 2", "* 3"],
    files: {
      "pyproject.toml": "[project]\nname = \"billing\"\nversion = \"1.0.0\"\n\n[tool.setuptools.packages.find]\nwhere = [\"src\"]\n",
      "src/billing/__init__.py": "",
      "src/billing/core.py": "from billing.rates import rate\n\n\nclass Invoice:\n    def total(self, amount):\n        return amount * 2 + rate()\n",
      "src/billing/rates.py": "def rate():\n    return 1\n",
      "tests/test_core.py": "from billing.core import Invoice\n\n\ndef test_total():\n    assert Invoice().total(1) == 3\n",
    },
    truth: { ".duo-project/decisions/D-902.yaml": DECISION("D-902", ['  requirements: [BILL-01]', '  paths: ["src/billing/**"]', '  symbols: ["Invoice.total"]']), ".duo-project/specs/billing.md": SPEC("BILL-01", "Invoices add the rate") },
    history: [] },
  { id: "cpp", language: "C++", configs: ["C"], llm: "C", target: "D-903", edit: ["Source/Game/Private/Weapon.cpp", "(void)Shots;", "(void)Shots; // tuned"],
    files: {
      "Source/Game/Public/Weapon.h": "class AWeapon {\npublic:\n  void Fire(int Shots);\n};\n",
      "Source/Game/Private/Weapon.cpp": "#include \"Weapon.h\"\n\nvoid AWeapon::Fire(int Shots) {\n  (void)Shots;\n}\n",
      "Source/Game/Private/Player.cpp": "#include \"Weapon.h\"\n\nvoid Shoot(AWeapon& W) {\n  W.Fire(1);\n}\n",
    },
    truth: { ".duo-project/decisions/D-903.yaml": DECISION("D-903", ['  requirements: [GAME-01]', '  symbols: ["AWeapon.Fire"]']), ".duo-project/specs/game.md": SPEC("GAME-01", "Weapons fire through AWeapon") },
    history: [] },
  { id: "sparse", language: "TypeScript/JavaScript", configs: ["D"], llm: "A", target: "Counter.add", edit: ["src/counter.ts", "+ 1", "+ 2"],
    files: { "package.json": JSON.stringify({ name: "counter", version: "0.1.0", type: "module" }) + "\n", "src/counter.ts": "export class Counter {\n  add(n: number): number {\n    return n + 1;\n  }\n}\n" },
    truth: {}, history: [] },
];

const setLlm = (root, variant) => {
  const f = path.join(root, ".duo-project", "project.yaml");
  const lines = fs.readFileSync(f, "utf8").replace(/\r\n/gu, "\n").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^llm:/u.test(line)) { skipping = true; continue; }
    if (skipping && (/^\s/u.test(line) || line === "")) { if (line === "") skipping = false; else continue; }
    else skipping = false;
    out.push(line);
  }
  let text = out.join("\n").replace(/\n*$/u, "\n");
  if (LLM[variant] !== null) text += LLM[variant];
  fs.writeFileSync(f, text);
  return text;
};
const truthState = (g) => ({ tree: g("ls-files", "-s", ".duo-project").trim(), status: g("status", "--porcelain", "--untracked-files=all", "--", ".duo-project").trim() });
const codes = (j) => (j?.diagnostics ?? []).map((d) => d.code);

const results = [];
for (const fx of FIXTURES) {
  const root = path.join(work, "repo-" + fx.id);
  fs.mkdirSync(root);
  const g = (...a) => execFileSync("git", a, { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true });
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  g("-c", "init.defaultBranch=main", "init", "-q"); g("config", "core.autocrlf", "false"); g("config", "commit.gpgsign", "false");
  for (const [f, t] of Object.entries(fx.files)) write(f, t);
  g("add", "-A"); g("commit", "-qm", "initial import");
  for (const [f, from, to] of fx.history) { write(f, fs.readFileSync(path.join(root, f), "utf8").replace(from, to)); g("commit", "-qam", "change " + f); }
  for (const [f, t] of Object.entries(fx.truth)) write(f, t);
  const r = { id: fx.id, language: fx.language, configs: fx.configs, old: {}, rc: {} };
  // ---- the previous version adopts and indexes ----
  const hasTruth = Object.keys(fx.truth).length > 0;
  const init = duo(OLD, root, ["init", "--non-interactive", "--answers", "-", "--json", ...(hasTruth ? ["--repair", "--baseline-policy", "head"] : [])],
    hasTruth ? "[]" : JSON.stringify([{ question: "project_goal", value: "Count things." }]));
  r.old.init = { code: init.code, baseline: init.json?.result?.baseline?.status ?? null, diagnostics: codes(init.json) };
  check(init.code === 0, fx.id + ": " + FROM + " init exit " + init.code + " " + init.stderr.slice(0, 200));
  r.projectYaml = setLlm(root, fx.llm);
  g("add", "-A"); g("commit", "-qm", "adopt DUO");
  const oldIndex = duo(OLD, root, ["index", "--json"]);
  const oldStatus = duo(OLD, root, ["status", "--json"]);
  r.old.status = { code: oldStatus.code, index: oldStatus.json?.result?.index?.status ?? null, baseline: oldStatus.json?.result?.baseline?.status ?? null, llm: oldStatus.json?.result?.llm ?? null, truth: oldStatus.json?.result?.truth ?? null };
  check(oldIndex.code === 0 && oldStatus.code === 0 && r.old.status.index === "current", fx.id + ": " + FROM + " index/status not current: " + JSON.stringify(r.old.status));
  r.old.context = duo(OLD, root, ["context", fx.target, "--json"]).json?.result?.status ?? null;
  r.old.review = duo(OLD, root, ["review", "--json"]).json?.result?.status ?? null;
  // An agent connected by the previous version: the configuration launches duoctl from PATH, so after the upgrade it
  // starts the RC. Claude Code is connected only by the RC (a first install after the upgrade).
  const oldCodex = duo(OLD, root, ["install", "codex", "--yes", "--json"]);
  r.old.codex = oldCodex.code;
  check(oldCodex.code === 0, fx.id + ": " + FROM + " install codex exit " + oldCodex.code);
  const before = truthState(g);
  // ---- the release candidate opens the same repository ----
  const ver = duo(NEW, root, ["--version"]);
  r.rc.version = ver.stdout.trim();
  check(ver.code === 0 && r.rc.version.includes(pack.version), fx.id + ": --version " + JSON.stringify(r.rc.version));
  const s1 = duo(NEW, root, ["status", "--json"]);
  r.rc.statusBefore = { code: s1.code, initialized: s1.json?.result?.initialized ?? null, index: s1.json?.result?.index ?? null, baseline: s1.json?.result?.baseline?.status ?? null, llm: s1.json?.result?.llm ?? null, truth: s1.json?.result?.truth ?? null, diagnostics: codes(s1.json) };
  check(s1.code === 0 && r.rc.statusBefore.initialized === true, fx.id + ": RC status before index exit " + s1.code + " or not initialized");
  check(["stale", "incompatible", "current"].includes(r.rc.statusBefore.index?.status), fx.id + ": the " + FROM + " index is reported " + r.rc.statusBefore.index?.status);
  check(JSON.stringify(r.rc.statusBefore.truth) === JSON.stringify(r.old.status.truth), fx.id + ": Truth counts differ between " + FROM + " and RC");
  const d1 = duo(NEW, root, ["doctor", "--json"]);
  const summarize = (d) => ({ code: d.code, format: d.json?.result?.format ?? null, overall: d.json?.result?.overall ?? null,
    notOk: (d.json?.result?.checks ?? []).filter((c) => c.status !== "ok").map((c) => c.id + ":" + c.status + (c.reason ? "/" + c.reason : "")), next: (d.json?.result?.next ?? []).map((n) => n.id ?? n.action ?? n) });
  r.rc.doctorBefore = summarize(d1);
  check(d1.json?.format === "duo.cli.doctor/1" && r.rc.doctorBefore.format === "duo.doctor/1", fx.id + ": doctor formats");
  const ix = duo(NEW, root, ["index", "--json"]);
  r.rc.index = { code: ix.code, mode: ix.json?.result?.mode ?? null, fullRebuildReason: ix.json?.result?.fullRebuildReason ?? null, analyzed: ix.json?.result?.metrics?.files?.analyzed ?? null, written: ix.json?.result?.metrics?.graph?.written ?? null, diagnostics: codes(ix.json) };
  check(ix.code === 0, fx.id + ": RC index exit " + ix.code);
  // "current" is only true when nothing is out of date: then the index run parses nothing and writes nothing.
  if (r.rc.statusBefore.index?.status === "current") check(r.rc.index.mode === "incremental" && r.rc.index.analyzed === 0 && r.rc.index.written === false, fx.id + ": the RC reported the " + FROM + " index current but index did work " + JSON.stringify(r.rc.index));
  const s2 = duo(NEW, root, ["status", "--json"]);
  r.rc.statusAfter = { index: s2.json?.result?.index?.status ?? null, baseline: s2.json?.result?.baseline?.status ?? null, llm: s2.json?.result?.llm ?? null };
  check(r.rc.statusAfter.index === "current", fx.id + ": one RC index did not restore current (" + r.rc.statusAfter.index + ")");
  // The fixture commits the adoption after init, so HEAD is past the baseline commit ("advanced"). The RC must read the
  // 0.1.2 baseline exactly as 0.1.2 did: no re-adoption (missing) and no reinterpretation (incompatible).
  check(r.rc.statusBefore.baseline === r.old.status.baseline && r.rc.statusAfter.baseline === r.old.status.baseline && ["current", "advanced"].includes(r.old.status.baseline),
    fx.id + ": adoption baseline " + r.old.status.baseline + " (" + FROM + ") → " + r.rc.statusBefore.baseline + " / " + r.rc.statusAfter.baseline + " (RC)");
  const ctx = duo(NEW, root, ["context", fx.target, "--json"]);
  r.rc.context = { code: ctx.code, status: ctx.json?.result?.status ?? null };
  check(ctx.code === 0 && r.rc.context.status === "ready", fx.id + ": RC context " + JSON.stringify(r.rc.context));
  write(fx.edit[0], fs.readFileSync(path.join(root, fx.edit[0]), "utf8").replace(fx.edit[1], fx.edit[2]));
  duo(NEW, root, ["index", "--json"]);
  const rv = duo(NEW, root, ["review", "--json"]);
  r.rc.review = { code: rv.code, status: rv.json?.result?.status ?? null, verdict: rv.json?.result?.verdict ?? null, baseline: rv.json?.result?.baseline?.status ?? null, llmCalls: rv.json?.result?.metrics?.llmCalls ?? null,
    claims: (rv.json?.result?.claims ?? []).map((c) => c.rule + " " + (c.subject?.id ?? "") + " " + c.alignment + (c.provenance ? " " + c.provenance : "")) };
  check(rv.code === 0 && r.rc.review.status === "ready" && r.rc.review.baseline === "present" && r.rc.review.llmCalls === 0, fx.id + ": RC review " + JSON.stringify(r.rc.review));
  g("checkout", "--", fx.edit[0]);
  duo(NEW, root, ["index", "--json"]);
  r.rc.agents = {};
  for (const agent of ["codex", "claude-code"]) {
    const pre = agent === "codex" ? duo(NEW, root, ["install", "status", agent, "--json"]) : undefined;
    const inst = duo(NEW, root, ["install", agent, "--yes", "--json"]);
    const st = duo(NEW, root, ["install", "status", agent, "--json"]);
    r.rc.agents[agent] = { configuredBy: agent === "codex" ? FROM : "RC", statusBeforeInstall: pre?.code ?? null, install: inst.code, status: st.code,
      verify: inst.json?.result?.verify?.status ?? inst.json?.result?.verify?.ok ?? null, diagnostics: codes(inst.json) };
    check((pre === undefined || pre.code === 0) && inst.code === 0 && st.code === 0, fx.id + ": RC install " + agent + " " + JSON.stringify(r.rc.agents[agent]));
  }
  r.rc.doctorAfter = summarize(duo(NEW, root, ["doctor", "--json"]));
  check(r.rc.doctorAfter.code === 0 && r.rc.doctorAfter.overall !== "error", fx.id + ": RC doctor after the upgrade " + JSON.stringify(r.rc.doctorAfter));
  const after = truthState(g);
  r.truth = { tracked: before.tree.split("\n").length, unchanged: before.tree === after.tree && after.status === "" };
  check(r.truth.unchanged, fx.id + ": tracked Truth changed during the upgrade: " + after.status.slice(0, 300));
  const migration = [...r.rc.statusBefore.diagnostics, ...r.rc.index.diagnostics].filter((c) => /SCHEMA|MIGRAT|NOT_INITIALIZED|VERSION/u.test(c));
  r.reinitOrMigrationSignals = migration;
  check(migration.length === 0, fx.id + ": re-init or migration signals " + migration.join(", "));
  results.push(r);
  log(fx.id + ": " + FROM + " " + r.old.status.index + " → RC " + r.rc.statusBefore.index?.status + " → index " + r.rc.index.mode + " (" + r.rc.index.fullRebuildReason + ") → " + r.rc.statusAfter.index + "; context " + r.rc.context.status + ", review " + r.rc.review.verdict + "; Truth unchanged " + r.truth.unchanged);
}

const git = gitState();
const report = { format: "duo.release-upgrade/1", from: FROM, to: pack.version, integrity: pack.integrity, git: { commit: git.commit, clean: git.clean }, os: process.platform, node: process.version, repositories: results, problems, ok: problems.length === 0 };
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "release-upgrade.json"), JSON.stringify(report, null, 2) + "\n");
if (!KEEP) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
log(problems.length === 0 ? "OK" : problems.length + " problem(s):");
for (const p of problems) console.log("  - " + p);
process.exit(problems.length === 0 ? 0 : 1);
