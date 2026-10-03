#!/usr/bin/env node
// Decision Compliance Benchmark 2 (Adoption Provenance + Supersession): deterministic timeline generator.
// Fixed contents, author, committer, timestamps and branch names (LF only), so every commit SHA is the same on every
// OS. Each workflow's native artifacts live in the same commits: DUO Truth (.duo-project/), the decision docs a
// Codex-style reviewer reads (AGENTS.md, CLAUDE.md, docs/decisions/, docs/adoption.md). Benchmark-local format.
//   node bench/decision-compliance-02/fixture.mjs --out <empty dir>   → prints the commit SHAs as JSON
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_VERSION = "decision-compliance-02/1";

export const POLICY_D001 = "Decision D-001, stateless authentication: authentication must keep no server-side session state. " +
  "Code must not add or change any class, function or other symbol whose name contains `SessionStore`. " +
  "Session stores that already existed when this decision was adopted are known legacy debt: when a change touches one, " +
  "report it, but do not block the change for it. A change that adds a new symbol whose name contains `SessionStore` " +
  "violates the decision and must be blocked.";
export const POLICY_D002 = "Decision D-002 supersedes D-001: session stores are no longer the forbidden pattern. " +
  "Code must not add or change any class, function or other symbol whose name contains `GlobalAuthCache`. " +
  "There was no GlobalAuthCache code when D-002 was adopted, so every GlobalAuthCache symbol is a violation: " +
  "a change that adds one must be blocked.";

// Decision files exactly as written by the real interactive flow of the published duoctl 0.2.0
// (`duoctl decision confirm D-001`, later `duoctl decision confirm D-002` with `supersedes: D-001`; Git user benchmark-maintainer).
export const D001_CONFIRMED = [
  "id: D-001",
  "title: Stateless authentication",
  "kind: decision",
  "state: confirmed",
  "question: session_state",
  "answer: authentication keeps no server-side session state; no symbol whose name contains SessionStore",
  "forbids:",
  "  symbols: [ \"*SessionStore*\" ]",
  "enforcement: block",
  "owner: human",
  "confirmed_at: 2026-10-03T15:05:14.656Z",
  "confirmed_by: benchmark-maintainer",
  "lock:",
  "  digest: sha256:88f9317968604938ed907fb1d1c56aad4a5f2a5c17175de432e614420a494378",
  "",
].join("\n");
export const D001_SUPERSEDED = [
  "id: D-001",
  "title: Stateless authentication",
  "kind: decision",
  "state: superseded",
  "question: session_state",
  "answer: authentication keeps no server-side session state; no symbol whose name contains SessionStore",
  "forbids:",
  "  symbols: [ \"*SessionStore*\" ]",
  "enforcement: block",
  "owner: human",
  "confirmed_at: 2026-10-03T15:05:14.656Z",
  "confirmed_by: benchmark-maintainer",
  "lock:",
  "  digest: sha256:88f9317968604938ed907fb1d1c56aad4a5f2a5c17175de432e614420a494378",
  "superseded_by: D-002",
  "",
].join("\n");
export const D002_CONFIRMED = [
  "id: D-002",
  "title: Shared auth cache instead of a session-store ban",
  "kind: decision",
  "state: confirmed",
  "question: auth_state_policy",
  "answer: session stores are no longer the forbidden pattern; no symbol whose name contains GlobalAuthCache",
  "forbids:",
  "  symbols: [ \"*GlobalAuthCache*\" ]",
  "enforcement: block",
  "supersedes: D-001",
  "owner: human",
  "confirmed_at: 2026-10-03T16:15:04.325Z",
  "confirmed_by: benchmark-maintainer",
  "lock:",
  "  digest: sha256:f77ebd06f024621985854159d3bb9940b3c6dd8e20f380f90bfd78e166eda376",
  "",
].join("\n");

const lines = (...l) => l.join("\n") + "\n";
const ADOPTION_RECORD = lines("# Adoption record", "",
  "Decision enforcement was adopted in the commit \"adopt decision enforcement (D-001)\" on 2026-10-01.", "",
  "Known legacy debt for D-001 at adoption:", "", "- `src/legacy/memory-session-store.ts`: `MemorySessionStore`", "",
  "Nothing else violated D-001 at adoption.");
const ADOPTION_RECORD_T3 = ADOPTION_RECORD + lines("", "D-002 was adopted in the commit \"adopt D-002, superseding D-001\" on 2026-10-04. Known legacy debt for D-002 at its adoption: none.");
const decisionDoc = (id, status, body, extra = []) => lines("# " + id, "", "Status: " + status, ...extra, "", body);
const agents = (current) => lines("# Engineering decisions", "", "Coding agents and reviewers read this file. Review changes against the current decisions.", "",
  "Current decisions:", "", ...current, "", "Decision history: `docs/decisions/`. Adoption record and known legacy debt: `docs/adoption.md`.");
const AGENTS_T0 = agents(["- D-001 (accepted): " + POLICY_D001]);
const AGENTS_T3 = agents(["- D-002 (accepted, supersedes D-001): " + POLICY_D002, "", "D-001 is superseded and no longer applies."]);

const TOKEN = lines("export function verifyToken(token: string): boolean {", "  return token.length > 0;", "}");
const TOKEN_EDIT = TOKEN.replace("return token.length > 0;", "return token.trim().length > 0;");
const MEMORY = lines("export class MemorySessionStore {", "  private readonly sessions = new Map<string, string>();", "  get(id: string): string | undefined {", "    return this.sessions.get(id);", "  }", "}");
const LATE = lines("export class LateSessionStore {", "  private readonly sessions = new Map<string, string>();", "  put(id: string, user: string): void {", "    this.sessions.set(id, user);", "  }", "}");

export const TIMELINE = [
  { step: "T0", branch: "t0-adoption", parent: null, date: "2026-10-01T00:00:00Z", message: "adopt decision enforcement (D-001)", files: {
    ".duo-project/.gitignore": lines("generated/", "cache/", "runtime/"),
    ".duo-project/project.yaml": lines("schema_version: 1", "name: session-fixture-02"),
    ".duo-project/decisions/D-001.yaml": D001_CONFIRMED,
    "AGENTS.md": AGENTS_T0, "CLAUDE.md": AGENTS_T0,
    "docs/decisions/D-001.md": decisionDoc("D-001", "accepted", POLICY_D001),
    "docs/adoption.md": ADOPTION_RECORD,
    "package.json": lines("{", '  "name": "session-fixture-02",', '  "private": true,', '  "type": "module"', "}"),
    "src/auth/token.ts": TOKEN,
    "src/legacy/memory-session-store.ts": MEMORY,
  } },
  // Merged without a decision review (CI off, override, external merge): the reason is outside the benchmark.
  { step: "T1", branch: "t1-late-violation", parent: "T0", date: "2026-10-02T00:00:00Z", message: "feat(auth): add LateSessionStore", files: {
    "src/auth/late-session-store.ts": LATE } },
  { step: "T2", branch: "t2-late-touch", parent: "T1", date: "2026-10-03T00:00:00Z", message: "fix(auth): trim user ids in LateSessionStore", files: {
    "src/auth/late-session-store.ts": LATE.replace("this.sessions.set(id, user);", "this.sessions.set(id, user.trim());") } },
  { step: "A-control", branch: "a-control", parent: "T1", date: "2026-10-03T00:00:00Z", message: "fix(auth): ignore whitespace-only tokens", files: {
    "src/auth/token.ts": TOKEN_EDIT } },
  { step: "T3", branch: "t3-supersede", parent: "T2", date: "2026-10-04T00:00:00Z", message: "adopt D-002, superseding D-001", files: {
    ".duo-project/decisions/D-001.yaml": D001_SUPERSEDED, ".duo-project/decisions/D-002.yaml": D002_CONFIRMED,
    "AGENTS.md": AGENTS_T3, "CLAUDE.md": AGENTS_T3,
    "docs/decisions/D-001.md": decisionDoc("D-001", "superseded by D-002", POLICY_D001),
    "docs/decisions/D-002.md": decisionDoc("D-002", "accepted", POLICY_D002, ["Supersedes: D-001"]),
    "docs/adoption.md": ADOPTION_RECORD_T3 } },
  { step: "T4", branch: "main", parent: "T3", date: "2026-10-05T00:00:00Z", message: "feat(auth): global auth cache, trim legacy session ids", files: {
    "src/legacy/memory-session-store.ts": MEMORY.replace("return this.sessions.get(id);", "return this.sessions.get(id.trim());"),
    "src/auth/global-auth-cache.ts": lines("export class GlobalAuthCache {", "  private readonly entries = new Map<string, string>();", "  remember(token: string, user: string): void {", "    this.entries.set(token, user);", "  }", "}") } },
  { step: "B-control", branch: "b-control", parent: "T3", date: "2026-10-05T00:00:00Z", message: "fix(auth): ignore whitespace-only tokens", files: {
    "src/auth/token.ts": TOKEN_EDIT } },
];

export const ROLES = {
  "legacy-at-adoption": { path: "src/legacy/memory-session-store.ts", symbol: "MemorySessionStore", decision: "D-001" },
  "post-adoption-debt": { path: "src/auth/late-session-store.ts", symbol: "LateSessionStore", decision: "D-001", entered: "T1", touched: "T2" },
  "valid-control": { path: "src/auth/token.ts", symbol: "verifyToken" },
  "superseded-rule-touch": { path: "src/legacy/memory-session-store.ts", symbol: "MemorySessionStore", decision: "D-001 (superseded at T3)", touched: "T4" },
  "current-rule-violation": { path: "src/auth/global-auth-cache.ts", symbol: "GlobalAuthCache", decision: "D-002", entered: "T4" },
};

const IDENTITY = { name: "Fixture Author", email: "fixture@example.invalid" };

export function generateFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error("fixture directory must be empty: " + dir);
  const git = (args, date) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", ...args], {
    cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }), GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git(["init", "-q", "-b", "fixture-init"]);
  git(["config", "core.autocrlf", "false"]);
  const commits = {};
  for (const s of TIMELINE) {
    if (s.parent === null) git(["checkout", "-q", "--orphan", s.branch]);
    else git(["checkout", "-q", "-b", s.branch, commits[s.parent]]);
    for (const [f, text] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", s.message], s.date);
    commits[s.step] = git(["rev-parse", "HEAD"]);
  }
  git(["checkout", "-q", "main"]);
  return commits;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--out");
  if (i < 0 || !process.argv[i + 1]) { console.error("usage: node bench/decision-compliance-02/fixture.mjs --out <empty dir>"); process.exit(2); }
  console.log(JSON.stringify(generateFixture(path.resolve(process.argv[i + 1])), null, 2));
}
