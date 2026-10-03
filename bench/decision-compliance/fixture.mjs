#!/usr/bin/env node
// Decision Compliance Benchmark 1 (Legacy + New Violation): deterministic fixture generator.
// Builds a small TypeScript Git repository with fixed contents, author, committer, timestamps and branch names,
// so the baseline and change commits have the same SHA on every OS. Benchmark-local; not a DUO public format.
//   node bench/decision-compliance/fixture.mjs --out <empty dir>   → prints the commit SHAs as JSON
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_VERSION = "decision-compliance-01/1";

// The one human intent every workflow receives (AGENTS.md, CLAUDE.md, DUO Decision D-001, the DIY gate).
export const POLICY = "Decision D-001, stateless authentication: authentication must keep no server-side session state. " +
  "Code must not add or change any class, function or other symbol whose name contains `SessionStore`. " +
  "Session stores that already existed when this decision was adopted are known legacy debt: when a change touches one, " +
  "report it, but do not block the change for it. A change that adds a new symbol whose name contains `SessionStore` " +
  "violates the decision and must be blocked.";

const instructions = (file) => "# Engineering decisions\n\n" + (file === "CLAUDE.md" ? "Claude Code reads this file. " : "Coding agents read this file. ") +
  "Review changes against these decisions.\n\n## Stateless authentication (D-001)\n\n" + POLICY + "\n";

// D-001 exactly as written by the real interactive flow of the published duoctl 0.2.0
// (`duoctl decision confirm D-001`, typed ID, Git user benchmark-maintainer); the generator replays the confirmed file.
export const DECISION = [
  "id: D-001",
  "title: Stateless authentication",
  "kind: decision",
  "state: confirmed",
  "question: session_state",
  "answer: authentication keeps no server-side session state; no symbol whose name contains SessionStore",
  "forbids:",
  '  symbols: [ "*SessionStore*" ]',
  "enforcement: block",
  "owner: human",
  "confirmed_at: 2026-10-03T15:05:14.656Z",
  "confirmed_by: benchmark-maintainer",
  "lock:",
  "  digest: sha256:88f9317968604938ed907fb1d1c56aad4a5f2a5c17175de432e614420a494378",
  "",
].join("\n");

const lines = (...l) => l.join("\n") + "\n";
const TOKEN = lines("export function verifyToken(token: string): boolean {", "  return token.length > 0;", "}");
const COOKIE = lines("export class CookieSessionStore {", "  private readonly cookies = new Map<string, string>();", "  save(id: string, value: string): void {",
  "    this.cookies.set(id, value);", "  }", "}");

export const BASELINE_FILES = {
  ".duo-project/.gitignore": lines("generated/", "cache/", "runtime/"),
  ".duo-project/project.yaml": lines("schema_version: 1", "name: session-fixture"),
  ".duo-project/decisions/D-001.yaml": DECISION,
  "AGENTS.md": instructions("AGENTS.md"),
  "CLAUDE.md": instructions("CLAUDE.md"),
  "package.json": lines("{", '  "name": "session-fixture",', '  "private": true,', '  "type": "module"', "}"),
  // C: valid control code.
  "src/auth/token.ts": TOKEN,
  // A: legacy violation, never touched later.
  "src/legacy/memory-session-store.ts": lines("export class MemorySessionStore {", "  private readonly sessions = new Map<string, string>();",
    "  get(id: string): string | undefined {", "    return this.sessions.get(id);", "  }", "}"),
  // B: legacy violation, touched by the change.
  "src/legacy/cookie-session-store.ts": COOKIE,
};

// F: valid control change (both commits that contain it).
const CONTROL = {
  "src/auth/token.ts": TOKEN.replace("return token.length > 0;", "return token.trim().length > 0;"),
  "src/auth/token-signer.ts": lines("export class TokenSigner {", "  sign(payload: string): string {", '    return payload.split("").reverse().join("");', "  }", "}"),
};

export const CHANGE_FILES = {
  ...CONTROL,
  // D: new violation.
  "src/auth/redis-session-store.ts": lines("export class RedisSessionStore {", "  private readonly sessions = new Map<string, string>();",
    "  put(id: string, user: string): void {", "    this.sessions.set(id, user);", "  }", "}"),
  // E: harmless modification inside legacy violation B.
  "src/legacy/cookie-session-store.ts": COOKIE.replace("this.cookies.set(id, value);", "this.cookies.set(id, value.trim());"),
};
export const CONTROL_ONLY_FILES = { ...CONTROL };

export const ROLES = [
  { id: "A", role: "legacy-untouched", path: "src/legacy/memory-session-store.ts", symbol: "MemorySessionStore" },
  { id: "B/E", role: "legacy-touched", path: "src/legacy/cookie-session-store.ts", symbol: "CookieSessionStore" },
  { id: "D", role: "introduced", path: "src/auth/redis-session-store.ts", symbol: "RedisSessionStore" },
  { id: "C/F", role: "valid-control", path: "src/auth/token.ts", symbol: "verifyToken" },
  { id: "F", role: "valid-control", path: "src/auth/token-signer.ts", symbol: "TokenSigner" },
];

const IDENTITY = { name: "Fixture Author", email: "fixture@example.invalid" };
const DATES = { baseline: "2026-10-01T00:00:00Z", change: "2026-10-02T00:00:00Z", control: "2026-10-02T00:00:00Z" };

export function generateFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) throw new Error("fixture directory must be empty: " + dir);
  const git = (args, date) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", ...args], {
    cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email,
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }), GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); } };
  git(["init", "-q", "-b", "main"]);
  git(["config", "core.autocrlf", "false"]);
  write(BASELINE_FILES);
  git(["add", "-A"]);
  git(["commit", "-q", "--no-verify", "-m", "baseline: application with known session-store debt and Decision D-001"], DATES.baseline);
  const baseline = git(["rev-parse", "HEAD"]);
  git(["branch", "baseline"]);
  write(CHANGE_FILES);
  git(["add", "-A"]);
  git(["commit", "-q", "--no-verify", "-m", "feat(auth): token signer, redis session store, trim cookie values"], DATES.change);
  const change = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "-b", "control-only", baseline]);
  write(CONTROL_ONLY_FILES);
  git(["add", "-A"]);
  git(["commit", "-q", "--no-verify", "-m", "feat(auth): token signer, trimmed token check"], DATES.control);
  const controlOnly = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  return { baseline, change, controlOnly };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--out");
  if (i < 0 || !process.argv[i + 1]) { console.error("usage: node bench/decision-compliance/fixture.mjs --out <empty dir>"); process.exit(2); }
  console.log(JSON.stringify(generateFixture(path.resolve(process.argv[i + 1])), null, 2));
}
