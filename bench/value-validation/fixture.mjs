#!/usr/bin/env node
// Value Validation 01 (T81): the fixture repository for the A/B/C comparison and the deterministic detection test.
// One small JavaScript service with three written project rules. The same source and the same rule text go into every
// condition; each condition adds only its own tool artifacts:
//   A: AGENTS.md with the rules.
//   B: A + ESLint rules (no-restricted-imports, no-restricted-syntax), a dependency check script, "npm run check",
//      a Git pre-commit hook and a CI workflow; the two pre-existing violations get eslint-disable comments at adoption.
//   C: B + DUO 0.3.3: the same three rules as confirmed Decisions with forbids, the adoption baseline (duoctl init),
//      and duoctl install codex (MCP configuration and the DUO block in AGENTS.md).
// Every step that a person would do to set a condition up is timed and returned (setup cost).
//   node bench/value-validation/fixture.mjs --out <empty dir> --condition A|B|C [--duoctl <duoctl.js>] [--core <core dist index.js>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURE_VERSION = "value-validation-01/1";

/** The project rules, word for word the same in every condition (AGENTS.md, docs/decisions.md). */
export const RULES = [
  "R1. Code under src/ui/ must not import src/db/legacy-db.js, directly or through a module that re-exports it (such as src/db/index.js). Use src/db/client.js, or call a service under src/services/ (services may use legacy-db). The existing src/ui/legacy-orders-page.js is known legacy debt: editing it is allowed, adding new imports of legacy-db is not.",
  "R2. Do not add the npm dependency `moment`. Use Intl.DateTimeFormat.",
  "R3. Authentication is stateless: do not add a class, function or other symbol whose name contains SessionStore. The existing MemorySessionStore in src/auth/memory-session-store.js is known legacy debt: editing it is allowed.",
];

const lines = (...l) => l.join("\n") + "\n";

export const SOURCE = {
  ".gitignore": lines("node_modules/"),
  "package.json": lines("{", '  "name": "orders-app",', '  "version": "1.0.0",', '  "private": true,', '  "type": "module",', '  "scripts": {', '    "test": "node --test"', "  },", '  "dependencies": {}', "}"),
  "README.md": lines("# orders-app", "", "A small order service used to compare development workflows. See docs/decisions.md for the project rules."),
  "docs/decisions.md": lines("# Project rules", "", ...RULES.flatMap((r) => [r, ""])),
  "src/db/client.js": lines("export function query(sql, params = []) {", "  return { sql, params, rows: [] };", "}"),
  "src/db/index.js": lines('export { query } from "./client.js";', 'export { legacyQuery } from "./legacy-db.js";'),
  "src/db/legacy-db.js": lines("export function legacyQuery(sql) {", "  return [sql];", "}"),
  "src/services/orders.js": lines('import { query } from "../db/client.js";', "", "export function listOrders(minTotal = 0) {", '  return query("select * from orders where total >= ?", [minTotal]).rows;', "}"),
  "src/services/legacy-report.js": lines('import { legacyQuery } from "../db/legacy-db.js";', "", "export function legacyReport() {", '  return legacyQuery("select * from report");', "}"),
  "src/ui/orders-page.js": lines('import { listOrders } from "../services/orders.js";', "", "export function renderOrders(minTotal) {", '  return listOrders(minTotal).map((o) => `<li>${o.id}</li>`).join("");', "}"),
  "src/ui/legacy-orders-page.js": lines('import { legacyQuery } from "../db/legacy-db.js";', "", "export function renderLegacyOrders() {", '  return legacyQuery("select * from orders").join(",");', "}"),
  "src/auth/token.js": lines("export function verifyToken(token) {", '  return typeof token === "string" && token.length > 10;', "}"),
  "src/auth/memory-session-store.js": lines("export class MemorySessionStore {", "  constructor() {", "    this.sessions = new Map();", "  }", "  get(id) {", "    return this.sessions.get(id);", "  }", "}"),
  "test/orders.test.js": lines('import test from "node:test";', 'import assert from "node:assert";', 'import { listOrders } from "../src/services/orders.js";', "", 'test("listOrders returns rows", () => {', "  assert.deepEqual(listOrders(), []);", "});"),
};

export const AGENTS_A = lines("# Agent instructions", "", "Follow the project rules below. If a task cannot be done without breaking a rule, stop and ask the human; do not change the rules yourself.", "", ...RULES.map((r) => "- " + r));
export const AGENTS_B = AGENTS_A + lines("", "Before you finish, run `npm run check` and fix every error it reports. Do not add eslint-disable comments or edit eslint.config.js, scripts/check-deps.mjs or the rules to make the check pass.");

// B: the static checks a careful team would write for these rules. The two existing violations are suppressed at
// adoption (the usual practice when a lint rule is added to an existing code base).
export const ESLINT_CONFIG = lines(
  "export default [",
  "  {",
  '    files: ["src/ui/**/*.js"],',
  "    rules: {",
  '      "no-restricted-imports": ["error", { patterns: [{ group: ["**/db/legacy-db", "**/db/legacy-db.js"], message: "R1: UI code must not import src/db/legacy-db.js; use src/db/client.js." }] }],',
  "    },",
  "  },",
  "  {",
  '    files: ["src/**/*.js"],',
  "    rules: {",
  '      "no-restricted-syntax": ["error",',
  '        { selector: "ClassDeclaration[id.name=/SessionStore/]", message: "R3: no new SessionStore symbols (stateless authentication)." },',
  '        { selector: "FunctionDeclaration[id.name=/SessionStore/]", message: "R3: no new SessionStore symbols (stateless authentication)." },',
  '        { selector: "VariableDeclarator[id.name=/SessionStore/]", message: "R3: no new SessionStore symbols (stateless authentication)." },',
  '        { selector: "MethodDefinition[key.name=/SessionStore/]", message: "R3: no new SessionStore symbols (stateless authentication)." }],',
  "    },",
  "  },",
  "];",
);
export const CHECK_DEPS = lines(
  "// R2: the dependency check. Fails when package.json declares moment in any dependency field.",
  'import fs from "node:fs";',
  'const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
  'const forbidden = ["moment"];',
  'const found = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((f) => Object.keys(pkg[f] ?? {})).filter((d) => forbidden.includes(d));',
  'if (found.length > 0) { console.error("R2: forbidden dependency: " + found.join(", ")); process.exit(1); }',
);
export const PRE_COMMIT = lines("#!/bin/sh", "npm run check");
export const CI_WORKFLOW = lines("name: check", "on: [push, pull_request]", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - uses: actions/setup-node@v4", "        with:", "          node-version: 24", "      - run: npm ci", "      - run: npm run check");

/** The Decisions a person confirms in condition C: the same three rules, expressed with DUO forbids. */
export const DECISIONS = {
  "D-001": { title: "UI code does not use legacy-db", question: "legacy_db_in_ui", answer: RULES[0], forbids: ["  imported_paths: [\"src/db/legacy-db.js\"]"] },
  "D-002": { title: "No moment dependency", question: "date_library", answer: RULES[1], forbids: ["  dependencies: [\"moment\"]"] },
  "D-003": { title: "Stateless authentication", question: "session_state", answer: RULES[2], forbids: ["  symbols: [\"*SessionStore*\"]"] },
};

const GIT_ENV = { GIT_AUTHOR_NAME: "vv-maintainer", GIT_AUTHOR_EMAIL: "vv@example.invalid", GIT_COMMITTER_NAME: "vv-maintainer", GIT_COMMITTER_EMAIL: "vv@example.invalid" };
const write = (root, files) => { for (const [p, t] of Object.entries(files)) { const a = path.join(root, p); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, t); } };
export const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, windowsHide: true });
const timed = (steps, name, fn) => { const t = performance.now(); const r = fn(); steps.push({ step: name, ms: Math.round(performance.now() - t) }); return r; };
const node = (script, args, cwd, input) => spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1", DUO_LOCALE: "en" } });

/** Adds the B artifacts and suppresses the two pre-existing violations. */
export function addStaticChecks(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.scripts.check = "eslint src && node scripts/check-deps.mjs";
  pkg.devDependencies = { eslint: "10.x" };
  write(root, {
    "package.json": JSON.stringify(pkg, null, 2) + "\n", "eslint.config.js": ESLINT_CONFIG, "scripts/check-deps.mjs": CHECK_DEPS,
    ".githooks/pre-commit": PRE_COMMIT, ".github/workflows/check.yml": CI_WORKFLOW, "AGENTS.md": AGENTS_B,
  });
  for (const [file, find] of [["src/ui/legacy-orders-page.js", 'import { legacyQuery } from "../db/legacy-db.js";'], ["src/auth/memory-session-store.js", "export class MemorySessionStore {"]]) {
    const a = path.join(root, file);
    fs.writeFileSync(a, fs.readFileSync(a, "utf8").replace(find, "// eslint-disable-next-line -- legacy debt at adoption (R1/R3)\n" + find));
  }
  git(root, "config", "core.hooksPath", ".githooks");
}

/** Adds the DUO artifacts: Decisions confirmed by a person, adoption baseline, Codex integration. */
export async function addDuo(root, duoctl, coreIndex) {
  const steps = [];
  write(root, {
    ".duo-project/.gitignore": lines("generated/", "cache/", "runtime/"),
    ".duo-project/project.yaml": lines("schema_version: 1", "name: orders-app"),
    ...Object.fromEntries(Object.entries(DECISIONS).map(([id, d]) => [".duo-project/decisions/" + id + ".yaml", lines("id: " + id, "title: " + d.title, "kind: decision", "state: proposed", "question: " + d.question, "answer: " + JSON.stringify(d.answer), "forbids:", ...d.forbids, "enforcement: block")])),
  });
  const core = await import(pathToFileURL(coreIndex).href);
  const service = core.createDecisionService({ root });
  for (const id of Object.keys(DECISIONS)) {
    const t = performance.now();
    const r = await service.confirm({ kind: "human", name: "vv-maintainer" }, id);
    if (r.value === undefined) throw new Error("confirm " + id + ": " + JSON.stringify(r.diagnostics));
    steps.push({ step: "confirm " + id, ms: Math.round(performance.now() - t) });
  }
  git(root, "add", "-A");
  git(root, "commit", "--no-verify", "-qm", "Confirm project rules as DUO Decisions");
  timed(steps, "duoctl init", () => { const r = node(duoctl, ["init", "--non-interactive", "--answers", "-", "--json"], root, JSON.stringify([{ question: "project_goal", value: "A small order service." }])); if (r.status !== 0) throw new Error("init " + r.stdout + r.stderr); });
  timed(steps, "duoctl install codex", () => { const r = node(duoctl, ["install", "codex", "--yes", "--json"], root); if (r.status !== 0 && r.status !== 6) throw new Error("install " + r.stdout + r.stderr); });
  git(root, "add", "-A");
  git(root, "commit", "--no-verify", "-qm", "Adopt DUO");
  timed(steps, "duoctl index", () => node(duoctl, ["index"], root));
  return steps;
}

/** Builds the repository for one condition at <out>. Returns the adoption commit and the timed setup steps. */
export async function generate(out, condition, { duoctl, core } = {}) {
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(out + " is not empty");
  fs.mkdirSync(out, { recursive: true });
  const steps = [];
  git(out, "init", "-q", "-b", "main");
  git(out, "config", "core.autocrlf", "false");
  write(out, { ...SOURCE, "AGENTS.md": AGENTS_A });
  git(out, "add", "-A");
  git(out, "commit", "--no-verify", "-qm", "orders-app with written project rules");
  if (condition === "B" || condition === "C") {
    timed(steps, "add static checks (B)", () => addStaticChecks(out));
    git(out, "add", "-A");
    git(out, "commit", "--no-verify", "-qm", "Add static checks for the project rules");
  }
  if (condition === "C") {
    if (duoctl === undefined || core === undefined) throw new Error("condition C needs --duoctl and --core");
    steps.push(...await addDuo(out, duoctl, core));
  }
  return { fixture: FIXTURE_VERSION, condition, adoption: git(out, "rev-parse", "HEAD").trim(), setup: steps };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const arg = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
  const r = await generate(path.resolve(arg("--out") ?? "."), arg("--condition") ?? "A", { duoctl: arg("--duoctl"), core: arg("--core") });
  console.log(JSON.stringify(r, null, 2));
}

