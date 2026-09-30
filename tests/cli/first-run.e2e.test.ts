/**
 * 0.1.1 first-run guidance (T21, C214): human-readable CLI lines only. The --json output, diagnostics and exit
 * codes stay as in 0.1.0; these tests check the meaning of the new lines, not their exact wording.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { duoctl } from "./support.js";

vi.setConfig({ testTimeout: 180_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
const env = { ...process.env, DUO_LOCALE: "" };
const INIT = ["init", "--non-interactive", "--answers", "-"];

function repo(options: { commit?: boolean; file?: boolean } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-first-run-")));
  temps.push(root);
  const git = (...a: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...a], { cwd: root, env: gitEnv, windowsHide: true, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init", "-q");
  if (options.file !== false) {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "tasks.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  }
  if (options.commit !== false) { git("add", "-A"); git("commit", "-qm", "init"); }
  return root;
}
const text = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("first-run guidance (0.1.1)", () => {
  it("a successful init names the next step to connect either supported coding agent; --json is unchanged", () => {
    const human = duoctl(repo(), INIT, "[]", env);
    expect(human.code).toBe(0);
    const line = text(human).split(/\r?\n/u).find((l) => l.includes("duoctl install codex")) ?? "";
    expect(line).toContain("duoctl install claude-code");
    const json = duoctl(repo(), [...INIT, "--json"], "[]", env);
    expect(json.code).toBe(0);
    expect(json.json().format).toBe("duo.cli.init/1");
    expect(json.stdout).not.toContain("duoctl install codex");
  });

  it("status says how to refresh a stale index, never runs it, and keeps its exit code and --json", () => {
    const root = repo();
    expect(duoctl(root, [...INIT, "--json"], "[]", env).code).toBe(0);
    expect(text(duoctl(root, ["status"], undefined, env))).not.toContain("Run duoctl index");
    fs.appendFileSync(path.join(root, "src", "tasks.ts"), "export const sub = (a: number, b: number) => a - b;\n");
    const human = duoctl(root, ["status"], undefined, env);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/Index: stale\r?\n\s+Run duoctl index/u);
    const json = duoctl(root, ["status", "--json"], undefined, env);
    expect(json.code).toBe(0);
    expect(json.json().result.index.status).toBe("stale");
    expect(json.stdout).not.toContain("Run duoctl index");
    expect(duoctl(root, ["status", "--json"], undefined, env).json().result.index.status).toBe("stale"); // status did not index
  });

  it("C214: without an initial commit init still fails with exit 1 and says to commit first, then run init again", () => {
    const human = duoctl(repo({ commit: false, file: false }), INIT, "[]", env);
    expect(human.code).toBe(1);
    expect(text(human)).toContain("ADOPTION_HEAD_REQUIRED");
    expect(text(human)).toMatch(/initial commit/u);
    expect(text(human)).toMatch(/run duoctl init again/u);
    const json = duoctl(repo({ commit: false, file: false }), [...INIT, "--json"], "[]", env);
    expect(json.code).toBe(1);
    const diagnostic = json.json().diagnostics.find((d) => d.code === "ADOPTION_HEAD_REQUIRED") as { message?: string } | undefined;
    expect(diagnostic?.message).toBe("The repository has no commit yet; commit once before capturing the Adoption Baseline");
    expect(json.stdout).not.toContain("initial commit");
  });

  it("C214: without an initial commit but with files init still asks for the dirty policy (exit 6) and says to commit first", () => {
    const human = duoctl(repo({ commit: false }), INIT, "[]", env);
    expect(human.code).toBe(6);
    expect(text(human)).toMatch(/initial commit/u);
    expect(text(human)).toMatch(/run duoctl init again/u);
    const json = duoctl(repo({ commit: false }), [...INIT, "--json"], "[]", env);
    expect(json.code).toBe(6);
    expect(json.json().diagnostics.map((d) => d.code)).toContain("ADOPTION_DIRTY_POLICY_REQUIRED");
    expect(json.stdout).not.toContain("initial commit");
  });
});

