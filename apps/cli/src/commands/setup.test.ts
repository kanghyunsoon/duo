/**
 * duoctl setup (T183, Jira S15P31A106-318): nothing is written before the single confirmation, every refusal
 * writes nothing, a failure after the confirmation keeps Truth and names the resume command, and a rerun
 * preserves Truth and user files. In-process (scripted terminal); the built-CLI journeys of init and install
 * stay in tests/cli.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDiagnostic } from "@duo-director/core";
import { run, type Io } from "../cli.js";
import { setupCommand, type SetupAgentStep, type SetupStepContext } from "./setup.js";
import type { Env } from "./shared.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const gitEnv = {
  ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@duo.invalid", GIT_AUTHOR_DATE: "2025-03-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@duo.invalid", GIT_COMMITTER_DATE: "2025-03-01T00:00:00Z",
};

function repo(options: { git?: boolean; commit?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-setup-")));
  temps.push(root);
  const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", windowsHide: true });
  write("README.md", "# Orbit Tasks\n\nOrbit Tasks schedules recurring chores for small teams and reminds whoever is next.\n");
  write("package.json", JSON.stringify({ name: "orbit-tasks", version: "1.0.0", type: "module" }, null, 2) + "\n");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "import { a } from \"./a.js\";\n\nexport const b = a + 1;\n");
  // A user's own agent configuration: setup without agent steps must leave it byte for byte.
  write(".codex/config.toml", "# mine\nmodel = \"x\"\n");
  write("AGENTS.md", "# House rules\n\nBe kind.\n");
  if (options.git !== false) {
    git("-c", "init.defaultBranch=main", "init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "commit.gpgsign", "false");
    if (options.commit !== false) { git("add", "-A"); git("commit", "-qm", "initial"); }
  }
  return { root, write, git };
}

/** Every file outside .git with a hash of its bytes (SQLite WAL sidecars of a reader left out). */
function snapshot(root: string, filter: (f: string) => boolean = () => true): [string, string][] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => !f.split(path.sep).includes(".git") && !/\.db-(?:wal|shm)$/u.test(f) && filter(f.split(path.sep).join("/"))).sort()
    .map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex") : "<dir>"]);
}
const userFiles = (f: string) => !f.startsWith(".duo-project");
/** Project Truth and history: everything in .duo-project but regenerable state. */
const truthFiles = (f: string) => f.startsWith(".duo-project/") && !/^\.duo-project\/(?:generated|cache|runtime)(?:\/|$)/u.test(f);

function terminal(root: string, options: { tty?: boolean; answers?: string[] } = {}) {
  const prompts: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    out: (l) => out.push(l), err: (l) => err.push(l), isTTY: options.tty ?? false,
    prompt: (q) => { prompts.push(q); return Promise.resolve(answers.shift()); },
    readStdin: () => Promise.resolve(""), cwd: () => root, now: () => new Date("2026-10-30T00:00:00Z"), env: { ...process.env, DUO_LOCALE: "" },
  };
  return { io, prompts, out, err, unanswered: answers };
}

async function setup(root: string, args: string[], options: { tty?: boolean; answers?: string[] } = {}) {
  const t = terminal(root, options);
  const code = await run(["setup", ...args], t.io);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed CLI JSON; the tests assert its shape
  const json = () => JSON.parse(t.out.join("\n")) as { result: any; diagnostics: { code: string }[] };
  return { ...t, code, json };
}

const isConfirm = (q: string) => q.startsWith("Apply this setup?");

describe("duoctl setup: refusals write nothing", () => {
  it("outside a Git repository", async () => {
    const r = repo({ git: false });
    const before = snapshot(r.root);
    const s = await setup(r.root, ["--yes", "--json"]);
    expect(s.code).toBe(1);
    expect(s.json().result.status).toBe("blocked");
    expect(s.json().diagnostics.map((d) => d.code)).toContain("GIT_REPOSITORY_REQUIRED");
    expect(snapshot(r.root)).toEqual(before);
  });

  it("an unborn HEAD is refused before any question", async () => {
    const r = repo({ commit: false });
    const before = snapshot(r.root);
    const tty = await setup(r.root, [], { tty: true, answers: ["y", "y", "y", "y", "y"] });
    expect(tty.code).toBe(6);
    expect(tty.prompts).toEqual([]);
    expect(tty.err.join("\n")).toContain("no commit yet");
    const json = await setup(r.root, ["--yes", "--json", "--baseline-policy", "head"]);
    expect(json.code).toBe(6);
    expect(json.json().diagnostics.map((d) => d.code)).toContain("ADOPTION_HEAD_REQUIRED");
    expect(snapshot(r.root)).toEqual(before);
  });

  it("a dirty tree needs a policy; a missing policy and abort write nothing, head captures a HEAD baseline", async () => {
    const r = repo();
    r.write("src/c.ts", "export const c = 3;\n");
    const before = snapshot(r.root);
    const missing = await setup(r.root, ["--yes", "--json"]);
    expect(missing.code).toBe(6);
    expect(missing.json().diagnostics.map((d) => d.code)).toContain("ADOPTION_DIRTY_POLICY_REQUIRED");
    const aborted = await setup(r.root, ["--yes", "--json", "--baseline-policy", "abort"]);
    expect(aborted.code).toBe(6);
    expect(aborted.json().result.steps.baseline.status).toBe("aborted");
    const asked = await setup(r.root, [], { tty: true, answers: ["2"] });
    expect(asked.code).toBe(6);
    expect(asked.prompts).toEqual(["> "]);
    expect(snapshot(r.root)).toEqual(before);
    const head = await setup(r.root, ["--yes", "--json", "--baseline-policy", "head"]);
    expect(head.code).toBe(0);
    expect(head.json().result.baseline).toMatchObject({ status: "captured", dirtyAtAdoption: true });
    expect(snapshot(r.root, userFiles)).toEqual(before);
  });

  it("partial .duo-project needs --repair and a conflicting one blocks", async () => {
    const partial = repo();
    partial.write(".duo-project/intent/notes.md", "mine\n");
    const before = snapshot(partial.root);
    const s = await setup(partial.root, ["--yes", "--json"]);
    expect(s.code).toBe(6);
    expect(s.json().diagnostics.map((d) => d.code)).toContain("INIT_REPAIR_REQUIRED");
    expect(snapshot(partial.root)).toEqual(before);

    const conflict = repo();
    conflict.write(".duo-project", "not a directory\n");
    const was = snapshot(conflict.root);
    const c = await setup(conflict.root, ["--yes", "--json"]);
    expect(c.code).toBe(1);
    expect(c.json().result.status).toBe("blocked");
    expect(snapshot(conflict.root)).toEqual(was);
  });

  it("non-interactive without --yes shows the plan and asks for --yes", async () => {
    const r = repo();
    const before = snapshot(r.root);
    const s = await setup(r.root, []);
    expect(s.code).toBe(6);
    expect(s.out.join("\n")).toContain("Setup plan");
    expect(s.err.join("\n")).toContain("Rerun with --yes");
    const json = await setup(r.root, ["--json"]);
    expect(json.json().result).toMatchObject({ status: "confirmation-required", plan: { state: "not-initialized" } });
    expect(snapshot(r.root)).toEqual(before);
  });
});

describe("duoctl setup: one confirmation, then apply", () => {
  it("asks the human questions, then one confirmation; declining writes nothing", async () => {
    const r = repo();
    const before = snapshot(r.root);
    const s = await setup(r.root, [], { tty: true, answers: ["y", "MVP", "No cloud sync", "n"] });
    expect(s.code).toBe(1);
    expect(s.prompts.filter(isConfirm)).toHaveLength(1);
    expect(isConfirm(s.prompts.at(-1) ?? "")).toBe(true);
    expect(s.err.join("\n")).toContain("Cancelled; nothing written.");
    expect(snapshot(r.root)).toEqual(before);
  });

  it("applies Truth, index and baseline after one confirmation; a rerun changes nothing", async () => {
    const r = repo();
    const before = snapshot(r.root);
    const s = await setup(r.root, [], { tty: true, answers: ["y", "MVP", "No cloud sync", "y"] });
    expect(s.unanswered).toEqual([]);
    expect(s.prompts.filter(isConfirm)).toHaveLength(1);
    expect(s.code).toBe(0);
    expect(s.out.join("\n")).toContain("DUO setup finished.");
    expect(s.out.join("\n")).toContain("DUO does not commit.");
    // The plan lists exactly the files apply created with these answers.
    const planned = /create (\d+) files in \.duo-project/u.exec(s.out.join("\n"))?.[1];
    const created = /^Truth {6}ok · (\d+) files/mu.exec(s.out.join("\n"))?.[1];
    expect(planned).toBeDefined();
    expect(planned).toBe(created);
    expect(fs.existsSync(path.join(r.root, ".duo-project/project.yaml"))).toBe(true);
    expect(snapshot(r.root, userFiles)).toEqual(before);
    const truth = snapshot(r.root, truthFiles);

    const again = await setup(r.root, ["--json"]);
    expect(again.code).toBe(0);
    expect(again.json().result).toMatchObject({
      status: "unchanged",
      steps: { truth: { status: "existing" }, index: { status: "existing" }, baseline: { status: "existing" } },
    });
    const tty = await setup(r.root, [], { tty: true, answers: ["y"] });
    expect(tty.prompts).toEqual([]);
    expect(snapshot(r.root, truthFiles)).toEqual(truth);
    expect(snapshot(r.root, userFiles)).toEqual(before);
  });

  it("continues an init that stopped at the baseline (C214) after the first commit", async () => {
    const r = repo({ commit: false });
    const initRun = await run(["init", "--non-interactive", "--baseline-policy", "head"], terminal(r.root).io);
    expect(initRun).toBe(1);
    expect(fs.existsSync(path.join(r.root, ".duo-project/project.yaml"))).toBe(true);
    r.git("add", "-A");
    r.git("commit", "-qm", "initial");
    const truth = snapshot(r.root, truthFiles);
    const s = await setup(r.root, ["--yes", "--json"]);
    expect(s.code).toBe(0);
    expect(s.json().result).toMatchObject({ status: "set-up", steps: { truth: { status: "existing" }, baseline: { status: "ok" } } });
    expect(snapshot(r.root, (f) => truthFiles(f) && !f.startsWith(".duo-project/reviews"))).toEqual(truth.filter(([f]) => !f.split(path.sep).join("/").startsWith(".duo-project/reviews")));
  });
});

describe("duoctl setup: the agent step interface (for Jira -319)", () => {
  const env = (root: string, t: ReturnType<typeof terminal>, overrides: Partial<Env> = {}): Env => ({ root, json: false, locale: "en", nonInteractive: false, yes: false, verbose: false, io: t.io, ...overrides });
  function fakeStep(behaviour: { blocker?: boolean; fail?: boolean | "throw"; seen?: SetupStepContext[] } = {}): SetupAgentStep & { applied: number } {
    const step = {
      id: "fake", applied: 0,
      plan: (context: SetupStepContext) => {
        behaviour.seen?.push(context);
        const connected = fs.existsSync(path.join(context.env.root, "FAKE.md"));
        return Promise.resolve({
          willCreate: connected ? [] : ["FAKE.md"], willModify: [], noop: connected,
          blockers: behaviour.blocker === true ? [createDiagnostic("AGENT_INTEGRATION_CONFLICT", "FAKE.md belongs to someone else")] : [],
          lines: ["  fake       create FAKE.md"],
        });
      },
      apply: (context: SetupStepContext) => {
        step.applied++;
        if (behaviour.fail === "throw") return Promise.reject(new Error("fake crashed"));
        if (behaviour.fail === true) return Promise.resolve({ ok: false, diagnostics: [createDiagnostic("AGENT_VERIFY_FAILED", "fake server did not start")], lines: [], remaining: [] });
        fs.writeFileSync(path.join(context.env.root, "FAKE.md"), "fake\n");
        return Promise.resolve({ ok: true, diagnostics: [], lines: ["fake connected"], remaining: ["Approve fake in the fake agent"] });
      },
    };
    return step;
  }

  it("a step blocker stops setup before any question or write", async () => {
    const r = repo();
    const before = snapshot(r.root);
    const t = terminal(r.root, { tty: true, answers: ["y", "y", "y", "y"] });
    const step = fakeStep({ blocker: true });
    const o = await setupCommand(env(r.root, t), { repair: false, answersFromStdin: false }, [step]);
    expect(o.exitCode).toBe(6);
    expect(o.result).toMatchObject({ status: "blocked" });
    expect(t.prompts).toEqual([]);
    expect(step.applied).toBe(0);
    expect(snapshot(r.root)).toEqual(before);
  });

  it("a step failure after the confirmation keeps Truth and names the resume; the rerun finishes", async () => {
    const r = repo();
    const seen: SetupStepContext[] = [];
    const t = terminal(r.root, { tty: true, answers: ["y", "", "", "y"] });
    const failing = await setupCommand(env(r.root, t), { repair: false, answersFromStdin: false }, [fakeStep({ fail: true, seen })]);
    expect(failing.exitCode).toBe(1);
    expect(failing.result).toMatchObject({ status: "failed", resume: "duoctl setup", steps: { truth: { status: "ok" }, baseline: { status: "ok" }, agents: { fake: { status: "failed" } } } });
    expect(failing.human.join("\n")).toContain("Project Truth is never deleted");
    expect(fs.existsSync(path.join(r.root, ".duo-project/project.yaml"))).toBe(true);
    expect(seen.map((c) => c.truthPlanned)).toEqual([true]);
    const truth = snapshot(r.root, truthFiles);

    const crashing = await setupCommand(env(r.root, terminal(r.root, { tty: true, answers: ["y"] })), { repair: false, answersFromStdin: false }, [fakeStep({ fail: "throw" })]);
    expect(crashing.result).toMatchObject({ status: "failed", resume: "duoctl setup", steps: { truth: { status: "existing" }, agents: { fake: { status: "failed" } } } });
    expect(crashing.diagnostics.map((d) => d.message).join("\n")).toContain("fake crashed");

    const t2 = terminal(r.root, { tty: true, answers: ["y"] });
    const finished = await setupCommand(env(r.root, t2), { repair: false, answersFromStdin: false }, [fakeStep({ seen })]);
    expect(t2.prompts.filter(isConfirm)).toHaveLength(1);
    expect(finished.result).toMatchObject({ status: "set-up", steps: { truth: { status: "existing" }, agents: { fake: { status: "ok" } } }, remaining: ["Approve fake in the fake agent"] });
    expect(finished.human.join("\n")).toContain("Left for you outside DUO:");
    expect(seen.map((c) => c.truthPlanned)).toEqual([true, false]);
    expect(snapshot(r.root, truthFiles)).toEqual(truth);

    const t3 = terminal(r.root, { tty: true });
    const unchanged = await setupCommand(env(r.root, t3), { repair: false, answersFromStdin: false }, [fakeStep()]);
    expect(unchanged.result).toMatchObject({ status: "unchanged", steps: { agents: { fake: { status: "existing" } } } });
    expect(t3.prompts).toEqual([]);
  });
});
