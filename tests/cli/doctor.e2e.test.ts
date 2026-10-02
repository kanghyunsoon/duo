/**
 * duoctl doctor (T26.1): read-only diagnostics across the first-run lifecycle, through the built duoctl as a
 * subprocess (pnpm test:conformance runs the same journeys against the installed package). Assertions use the
 * machine fields of duo.doctor/1 (check IDs, statuses, reason codes, next actions) and the exit code; human lines
 * are checked for their meaning only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_CHECK_IDS, MCP_TOOLS } from "@duo-director/integration";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject, snapshot, type CliRun } from "./support.js";
import { duoctlBin, envWithPath } from "../install/support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@duo.invalid", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@duo.invalid" };
// Key-shaped canaries (OpenAI-like and AWS-like). Doctor may say that a key is set; it never shows one.
const OPENAI_CANARY = "sk-proj-DUODOCTORCANARY0123456789abcdef";
const AWS_CANARY = "AKIADUODOCTORCANARY1";

let env: NodeJS.ProcessEnv = {};
beforeAll(() => {
  env = { ...envWithPath([duoctlBin(temps)]), OPENAI_API_KEY: OPENAI_CANARY, AWS_ACCESS_KEY_ID: AWS_CANARY };
});

const tempDir = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-doctor-"))); temps.push(d); return d; };
const git = (root: string, ...a: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", ...a], { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true });
/** A Git repository from a fixture (or one TypeScript file), committed unless commit is false. */
function repo(fixture?: string, options: { commit?: boolean } = {}): string {
  const root = tempDir();
  if (fixture === undefined) { fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src", "app.ts"), "export const answer = 42;\n"); }
  else fs.cpSync(path.join(REPO, "fixtures", ...fixture.split("/")), root, { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  if (options.commit !== false) { git(root, "add", "-A"); git(root, "commit", "-qm", "fixture"); }
  return root;
}
const init = (root: string, extra: string[] = []) => expect(duoctl(root, ["init", "--non-interactive", "--answers", "-", "--json", ...extra], "[]", env).code).toBe(0);
const doctor = (root: string, extra: string[] = [], e: NodeJS.ProcessEnv = env) => duoctl(root, ["doctor", "--json", ...extra], "", e);
const human = (root: string, extra: string[] = [], e: NodeJS.ProcessEnv = env) => { const r = duoctl(root, ["doctor", ...extra], "", e); return { code: r.code, text: r.stdout + r.stderr }; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed duo.doctor/1
const check = (r: CliRun, id: string): any => r.json().result.checks.find((c: { id: string }) => c.id === id);
const nextIds = (r: CliRun) => (r.json().result.next as { id: string }[]).map((a) => a.id);
const noSecrets = (...texts: string[]) => { for (const s of texts) { expect(s).not.toContain(OPENAI_CANARY); expect(s).not.toContain(AWS_CANARY); } };
/** Doctor runs and leaves files (and Git status, in a repository) as they were. */
function unchanged(root: string, run: () => void) {
  const state = () => ({ files: snapshot(root), status: fs.existsSync(path.join(root, ".git")) ? git(root, "status", "--porcelain", "--untracked-files=all") : null });
  const before = state();
  run();
  expect(state()).toEqual(before);
}

describe("duoctl doctor: Git and Project Truth prerequisites (A–C)", () => {
  it("A: not a Git repository is one error, every other check waits for it; exit 6, write 0", () => {
    const root = tempDir();
    unchanged(root, () => {
      const r = doctor(root);
      expect(r.code).toBe(6);
      const j = r.json();
      expect(j).toMatchObject({ format: "duo.cli.doctor/1", ok: false, exitCode: 6, result: { format: "duo.doctor/1", overall: "action-required" } });
      expect(j.result.checks.map((c: { id: string }) => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
      expect(check(r, "git.repository")).toMatchObject({ status: "error", reason: "not-a-repository" });
      expect(j.result.checks.filter((c: { status: string }) => c.status !== "skipped").map((c: { id: string }) => c.id)).toEqual(["runtime.node", "git.repository"]);
      expect(nextIds(r)).toEqual(["git-init"]);
    });
    expect(fs.existsSync(path.join(root, ".duo-project"))).toBe(false);
  });

  it("B: git init without a commit says to commit first, then run init", () => {
    const root = repo(undefined, { commit: false });
    const r = doctor(root);
    expect(r.code).toBe(6);
    expect(check(r, "git.initial_commit")).toMatchObject({ status: "error", reason: "unborn" });
    expect(check(r, "truth.project")).toMatchObject({ status: "error", reason: "not-initialized" });
    expect(check(r, "truth.baseline")).toMatchObject({ status: "skipped" });
    expect(check(r, "git.working_tree")).toMatchObject({ status: "info", reason: "dirty-before-adoption", facts: { untracked: 1 } });
    expect(nextIds(r)).toEqual(["git-first-commit", "init"]);
  });

  it("C: a committed repository without DUO gets exactly duoctl init, no agent step before Truth, and doctor creates nothing", () => {
    const root = repo();
    unchanged(root, () => {
      const r = doctor(root);
      expect(r.code).toBe(6);
      expect(check(r, "git.initial_commit")).toMatchObject({ status: "ok", reason: "present", facts: { branch: "main" } });
      expect(check(r, "truth.project")).toMatchObject({ status: "error", reason: "not-initialized" });
      for (const id of ["truth.baseline", "index.freshness", "analysis.coverage", "agent.codex", "agent.claude_code", "llm.configuration"]) expect(check(r, id), id).toMatchObject({ status: "skipped" });
      expect(r.json().result.next).toEqual([{ id: "init", commands: ["duoctl init"] }]);
      const h = human(root);
      expect(h.text).toMatch(/Run duoctl init/u);
      expect(h.text).not.toMatch(/duoctl install/u);
    });
    expect(fs.existsSync(path.join(root, ".duo-project"))).toBe(false);
  });
});

describe("duoctl doctor: index lifecycle (D–G)", () => {
  let root = "";
  beforeAll(() => { root = repo("languages/typescript"); init(root); });

  it("F, J: initialized and current is ready (exit 0); TypeScript is L2; both agents are offered as one step, neither as a default", () => {
    unchanged(root, () => {
      const r = doctor(root);
      expect(r.code).toBe(0);
      expect(r.json()).toMatchObject({ ok: true, result: { overall: "ready" } });
      expect(check(r, "analysis.coverage").facts.languages).toEqual(expect.arrayContaining([expect.objectContaining({ language: "typescript", level: "L2" })]));
      expect(check(r, "truth.project")).toMatchObject({ status: "ok", reason: "valid" });
      expect(check(r, "truth.baseline")).toMatchObject({ status: "ok", reason: "current" });
      expect(check(r, "index.freshness")).toMatchObject({ status: "ok", reason: "current" });
      expect(check(r, "agent.codex")).toMatchObject({ status: "info", reason: "not-configured" });
      expect(check(r, "agent.claude_code")).toMatchObject({ status: "info", reason: "not-configured" });
      expect(check(r, "llm.configuration")).toMatchObject({ status: "info", reason: "disabled" });
      expect(r.json().result.next).toEqual([{ id: "connect-agent", commands: ["duoctl install codex", "duoctl install claude-code"] }]);
    });
    const h = human(root);
    expect(h.text).toMatch(/duoctl install codex · duoctl install claude-code/u);
    expect(h.text).not.toMatch(/duoctl ui/u);
  });

  it("E: a stale index is a warning with duoctl index first (exit 0); doctor does not index", () => {
    fs.writeFileSync(path.join(root, "src", "added.ts"), "export const added = 1;\n");
    unchanged(root, () => {
      const r = doctor(root);
      expect(r.code).toBe(0);
      expect(r.json().result.overall).toBe("warnings");
      expect(check(r, "index.freshness")).toMatchObject({ status: "warning", reason: "stale", facts: { files: 1 } });
      expect(r.json().result.next[0]).toEqual({ id: "index", commands: ["duoctl index"] });
    });
    expect(duoctl(root, ["status", "--json"], "", env).json().result.index.status).toBe("stale");
  });

  it("D: a missing index is an error (exit 6) with duoctl index; coverage still comes from the one inspection", () => {
    fs.rmSync(path.join(root, ".duo-project", "generated"), { recursive: true, force: true });
    const r = doctor(root);
    expect(r.code).toBe(6);
    expect(check(r, "index.freshness")).toMatchObject({ status: "error", reason: "missing" });
    expect(check(r, "analysis.coverage")).toMatchObject({ status: "info", reason: "coverage" });
    expect(r.json().result.next[0]).toEqual({ id: "index", commands: ["duoctl index"] });
    expect(fs.existsSync(path.join(root, ".duo-project", "generated", "graph.db"))).toBe(false);
  });

  it("G: an incompatible index state is an error (exit 6) with duoctl index, which rebuilds it", () => {
    expect(duoctl(root, ["index", "--json"], "", env).code).toBe(0);
    fs.writeFileSync(path.join(root, ".duo-project", "generated", "index-state.json"), "{\"format\":\"duo-index-state\",\"version\":1}\n");
    const r = doctor(root);
    expect(r.code).toBe(6);
    expect(check(r, "index.freshness")).toMatchObject({ status: "error", reason: "incompatible" });
    expect(r.json().result.next[0]).toEqual({ id: "index", commands: ["duoctl index"] });
    expect(duoctl(root, ["index", "--json"], "", env).code).toBe(0);
    expect(check(doctor(root), "index.freshness")).toMatchObject({ status: "ok", reason: "current" });
  });
});

describe("duoctl doctor: an existing dirty repository (H)", () => {
  it("before adoption the changes are explained with the init policy; after init --baseline-policy head they are normal", () => {
    const p = existingProject(temps);
    p.edit("src/scheduler.ts", "% 7", "% 5");
    p.write("notes.txt", "draft\n");
    const before = doctor(p.root);
    expect(before.code).toBe(6);
    expect(check(before, "git.working_tree")).toMatchObject({ status: "info", reason: "dirty-before-adoption", facts: { unstaged: 1, untracked: 1 } });
    expect(human(p.root).text).toMatch(/--baseline-policy head/u);
    expect(duoctl(p.root, ["init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], "[]", env).code).toBe(0);
    const after = doctor(p.root);
    expect(after.code).toBe(0);
    expect(check(after, "git.working_tree")).toMatchObject({ status: "info", reason: "dirty" });
    expect(check(after, "truth.baseline")).toMatchObject({ status: "ok", reason: "current", facts: { dirtyAtAdoption: true } });
  });
});

describe("duoctl doctor: analysis levels as published (I, L; J in F, K in Q)", () => {
  const levels = (root: string) => {
    init(root);
    const c = check(doctor(root), "analysis.coverage");
    expect(c).toMatchObject({ status: "info", reason: "coverage" });
    return { languages: Object.fromEntries((c.facts.languages as { language: string; level: string }[]).map((l) => [l.language, l.level])), fileOnly: c.facts.fileOnly as number };
  };

  it("unknown languages are file-level L0; a polyglot repository lists each language at its published level", () => {
    const unknown = levels(repo("languages/unknown"));
    expect(unknown.languages).toEqual({});
    expect(unknown.fileOnly).toBeGreaterThan(0);
    const poly = repo("languages/polyglot");
    expect(levels(poly).languages).toEqual({ cpp: "L1", csharp: "L1", java: "L1", python: "L1", typescript: "L2" });
    const h = human(poly).text;
    expect(h).toMatch(/typescript L2/u);
    expect(h).toMatch(/python L1/u);
    expect(h).toMatch(/L0/u);
  });
});

describe("duoctl doctor: agent integrations (M–P)", () => {
  let root = "";
  beforeAll(() => { root = repo("languages/typescript"); init(root); });
  const install = (agent: string) => expect(duoctl(root, ["install", agent, "--yes", "--non-interactive", "--json"], "", env).code).toBe(0);
  const expectedTools = Object.keys(MCP_TOOLS).length;

  it("M, O: a connected agent is verified by starting its MCP server (tool list from the server's own table); one or both, no default", () => {
    install("codex");
    unchanged(root, () => {
      const r = doctor(root);
      expect(r.code).toBe(0);
      expect(check(r, "agent.codex")).toMatchObject({ status: "ok", reason: "verified", facts: { tools: expectedTools, humanStep: "codex-trust" } });
      expect(check(r, "agent.claude_code")).toMatchObject({ status: "info", reason: "not-configured" });
      expect(r.json().result).toMatchObject({ overall: "ready", next: [] });
    });
    install("claude-code");
    const both = doctor(root);
    expect(both.code).toBe(0);
    expect(check(both, "agent.claude_code")).toMatchObject({ status: "ok", reason: "verified", facts: { tools: expectedTools, humanStep: "claude-approval" } });
    expect(check(both, "agent.codex")).toMatchObject({ status: "ok", reason: "verified" });
  });

  it("N: Claude Code alone is verified the same way", () => {
    const solo = repo("languages/typescript");
    init(solo);
    expect(duoctl(solo, ["install", "claude-code", "--yes", "--non-interactive", "--json"], "", env).code).toBe(0);
    const r = doctor(solo);
    expect(check(r, "agent.claude_code")).toMatchObject({ status: "ok", reason: "verified" });
    expect(check(r, "agent.codex")).toMatchObject({ status: "info", reason: "not-configured" });
  });

  it("P: a broken configuration and a server that does not start are errors with a manual step (exit 6); no secret from the file or the server output", () => {
    const mcpJson = path.join(root, ".mcp.json");
    const good = fs.readFileSync(mcpJson, "utf8");
    fs.writeFileSync(mcpJson, "{\"mcpServers\": {\"duo-director\": \"" + AWS_CANARY + "\" " + OPENAI_CANARY + " }\n");
    // A launcher that fails and prints a credential-shaped value on stderr.
    const bad = tempDir();
    if (process.platform === "win32") fs.writeFileSync(path.join(bad, "duoctl.cmd"), "@echo off\r\necho token " + OPENAI_CANARY + " " + AWS_CANARY + " 1>&2\r\nexit /b 3\r\n");
    else fs.writeFileSync(path.join(bad, "duoctl"), "#!/bin/sh\necho \"token " + OPENAI_CANARY + " " + AWS_CANARY + "\" >&2\nexit 3\n", { mode: 0o755 });
    const badEnv = { ...envWithPath([bad]), OPENAI_API_KEY: OPENAI_CANARY, AWS_ACCESS_KEY_ID: AWS_CANARY };
    unchanged(root, () => {
      const r = doctor(root, [], badEnv);
      expect(r.code).toBe(6);
      expect(check(r, "agent.claude_code")).toMatchObject({ status: "error", reason: "conflict", facts: { target: ".mcp.json" } });
      expect(check(r, "agent.codex")).toMatchObject({ status: "error", reason: "mcp-launch-failed" });
      expect(nextIds(r)).toEqual(expect.arrayContaining(["fix-agent-config", "fix-launcher"]));
      noSecrets(r.stdout, r.stderr);
      const h = duoctl(root, ["doctor"], "", badEnv);
      noSecrets(h.stdout, h.stderr);
      expect(h.stdout + h.stderr).toMatch(/\[REDACTED\]/u);
    });
    fs.writeFileSync(mcpJson, good);
  });
});

describe("duoctl doctor: optional LLM (Q–R) and output", () => {
  let root = "";
  beforeAll(() => { root = repo("languages/python-fastapi"); init(root); });

  it("K, Q: a Python repository is L1 and provider none is info; R: a configured provider without its key is a warning outside Next (exit 0); with a key it is configured and the value is never shown", () => {
    const none = doctor(root);
    expect(check(none, "llm.configuration")).toMatchObject({ status: "info", reason: "disabled" });
    expect(check(none, "analysis.coverage").facts.languages).toEqual([expect.objectContaining({ language: "python", level: "L1" })]);
    fs.appendFileSync(path.join(root, ".duo-project", "project.yaml"), "llm:\n  provider: openai-responses\n  model: test-model\n");
    expect(duoctl(root, ["index", "--json"], "", env).code).toBe(0);
    const { OPENAI_API_KEY: _key, ...withoutKey } = env;
    void _key;
    const missing = doctor(root, [], withoutKey);
    expect(missing.code).toBe(0);
    expect(check(missing, "llm.configuration")).toMatchObject({ status: "warning", reason: "credential-missing", facts: { provider: "openai-responses", model: "test-model", credentialEnv: "OPENAI_API_KEY" } });
    expect(nextIds(missing)).not.toContain("set-llm-credential");
    const configured = doctor(root);
    expect(check(configured, "llm.configuration")).toMatchObject({ status: "ok", reason: "configured" });
    noSecrets(configured.stdout, configured.stderr);
    const h = duoctl(root, ["doctor"], "", env);
    expect(h.stdout).toMatch(/OPENAI_API_KEY/u);
    noSecrets(h.stdout, h.stderr);
  });

  it("--json is deterministic and locale-free; --locale ko renders the same checks", () => {
    const a = doctor(root).json().result;
    expect(doctor(root, ["--locale", "ko"]).json().result).toEqual(a);
    const ko = human(root, ["--locale", "ko"]).text;
    expect(ko).toMatch(/다음/u);
    expect(ko).toMatch(/정상/u);
  });
});
