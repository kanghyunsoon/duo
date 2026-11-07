/**
 * T131 guard (#83 review): with DUO_TEST_DEFER_CONFORMANCE=1, pnpm test skips the conformance files and leaves them to
 * the release conformance step of the same CI job. If that step disappeared, ran with --skip-e2e, or could fail without
 * failing the job, the 13 deferred files (118 tests) would silently stop running while CI stays green. This test reads
 * .github/workflows/ci.yml and fails in that case, so pnpm test catches it before such a workflow change merges.
 *
 * The conformance step's command is pinned, not searched for: a trailing "|| exit 0", another line after it (on
 * Windows a multi-line run takes its exit code from the last line), a --skip-e2e flag or a custom shell would all let
 * a failing suite pass. Changing that step therefore means changing this guard on purpose.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseYaml } from "@duo-director/core";
import { DEFER_CONFORMANCE_ENV } from "../../vitest.conformance-files.js";

type Env = Readonly<Record<string, unknown>>;
interface RunDefaults { readonly defaults?: { readonly run?: { readonly shell?: unknown } } }
interface Step { readonly name?: string; readonly run?: string; readonly shell?: unknown; readonly if?: unknown; readonly env?: Env; readonly "continue-on-error"?: unknown }
interface Job extends RunDefaults { readonly steps?: readonly Step[]; readonly env?: Env; readonly "continue-on-error"?: unknown }
interface Workflow extends RunDefaults { readonly env?: Env; readonly jobs: Record<string, Job> }
const parsed = parseYaml({ path: ".github/workflows/ci.yml", text: fs.readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8") });
if (parsed.value === undefined) throw new Error(JSON.stringify(parsed.diagnostics));
const workflow = parsed.value.data as Workflow;

/** The step's effective shell across step, job defaults.run and workflow defaults.run (#161). */
const effectiveShell = (wf: RunDefaults, job: Job, step: Step): unknown =>
  step.shell ?? job.defaults?.run?.shell ?? wf.defaults?.run?.shell;

/** The step defers if the variable is "1" (or an expression that could be "1") in its effective env: workflow, job, step. */
const defers = (job: Job, step: Step): boolean => {
  const value = step.env?.[DEFER_CONFORMANCE_ENV] ?? job.env?.[DEFER_CONFORMANCE_ENV] ?? workflow.env?.[DEFER_CONFORMANCE_ENV];
  return value !== undefined && (String(value) === "1" || String(value).includes("$" + "{{"));
};
/** Any step that mentions the conformance runner; its exact shape is checked separately. */
const mentionsConformance = (step: Step) => /scripts\/release\/conformance\.mjs|test:conformance/u.test(step.run ?? "");
/** The only accepted commands: one line, the conformance runner last, optionally after the packed-artifact check. */
export const CONFORMANCE_RUN = /^(?:node scripts\/ci\/check-packed-artifact\.mjs && )?(?:node scripts\/release\/conformance\.mjs|pnpm (?:run )?test:conformance)$/u;

describe("CI defers conformance files only to a conformance step that runs them (T131)", () => {
  const deferring = Object.entries(workflow.jobs).filter(([, job]) => (job.steps ?? []).some((step) => defers(job, step)));

  it("the ci workflow defers them in at least one job", () => {
    expect(deferring.map(([id]) => id)).not.toEqual([]);
  });

  for (const [id, job] of deferring) {
    it(id + ": a later, unconditional step runs the full conformance suite against the packed tarball, and nothing can mask its failure", () => {
      const steps = job.steps ?? [];
      const deferredAt = steps.findIndex((step) => defers(job, step));
      const conformanceAt = steps.findIndex((step, i) => i > deferredAt && mentionsConformance(step));
      expect(conformanceAt, "no step after the deferring pnpm test runs scripts/release/conformance.mjs").toBeGreaterThan(deferredAt);
      const conformance = steps[conformanceAt] as Step;
      expect((conformance.run ?? "").trim(), "the conformance step's run must be exactly the pinned single-line command").toMatch(CONFORMANCE_RUN);
      expect(effectiveShell(workflow, job, conformance), "the conformance step must use the default shell").toBeUndefined();
      expect(conformance.if, "the conformance step must not be conditional").toBeUndefined();
      expect(conformance["continue-on-error"] ?? false).toBe(false);
      expect(job["continue-on-error"] ?? false).toBe(false);
      // The step reuses the tarball pnpm test:dist packed in the same job (scripts/ci/check-packed-artifact.mjs).
      const packedAt = steps.findIndex((step) => /pnpm (?:run )?test:dist(?:\s|$)/mu.test(step.run ?? ""));
      expect(packedAt).toBeGreaterThanOrEqual(0);
      expect(packedAt).toBeLessThan(conformanceAt);
      expect(steps.slice(packedAt, conformanceAt + 1).every((step) => step.if === undefined && (step["continue-on-error"] ?? false) === false)).toBe(true);
    });
  }
});

describe("the pinned conformance command (T131)", () => {
  it("accepts the current and the plain forms and refuses anything that could hide a failure", () => {
    for (const ok of ["node scripts/ci/check-packed-artifact.mjs && node scripts/release/conformance.mjs", "node scripts/release/conformance.mjs", "pnpm test:conformance", "pnpm run test:conformance"]) {
      expect(ok).toMatch(CONFORMANCE_RUN);
    }
    for (const bad of [
      "node scripts/ci/check-packed-artifact.mjs && node scripts/release/conformance.mjs || exit 0",
      "node scripts/ci/check-packed-artifact.mjs && node scripts/release/conformance.mjs\necho \"conformance finished\"",
      "node scripts/release/conformance.mjs --skip-e2e",
      "node scripts/release/conformance.mjs; true",
      "node scripts/release/conformance.mjs || true",
      "true || node scripts/release/conformance.mjs",
    ]) {
      expect(bad).not.toMatch(CONFORMANCE_RUN);
    }
  });

  it("reads the effective shell from the step, the job defaults and the workflow defaults (#161)", () => {
    expect(effectiveShell({}, {}, {})).toBeUndefined();
    expect(effectiveShell({ defaults: { run: { shell: "pwsh -command \". '{0}'; exit 0\"" } } }, {}, {})).toBe("pwsh -command \". '{0}'; exit 0\"");
    expect(effectiveShell({}, { defaults: { run: { shell: "bash" } } }, {})).toBe("bash");
    expect(effectiveShell({ defaults: { run: { shell: "sh" } } }, { defaults: { run: { shell: "bash" } } }, { shell: "cmd" })).toBe("cmd");
  });
});

describe("check-packed-artifact checks the packed commit SHA (#161) and a clean pack (#171)", () => {
  const CHECK_SCRIPT = fileURLToPath(new URL("../../scripts/ci/check-packed-artifact.mjs", import.meta.url));
  const TRACKED_SCRIPT = fileURLToPath(new URL("../../scripts/ci/tracked-changes.mjs", import.meta.url));
  let tmp = "";
  let head = "";
  let tarball = "";
  let integrity = "";
  let git: (...args: string[]) => string = () => "";

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duo-check-packed-artifact-"));
    fs.mkdirSync(path.join(tmp, "apps", "cli"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".dist"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps", "cli", "package.json"), JSON.stringify({ name: "@duo-director/cli", version: "0.4.0-rc.1" }));
    fs.writeFileSync(path.join(tmp, "src.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".dist/\n");
    git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8", windowsHide: true }).trim();
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    // The developer's global Git config must not decide the outcome (#171): no signing in this temporary repository.
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    git("add", "apps/cli/package.json", "src.ts", ".gitignore");
    git("commit", "-m", "init");
    head = git("rev-parse", "HEAD");
    tarball = path.join(tmp, ".dist", "duo-director-cli-0.4.0-rc.1.tgz");
    const bytes = Buffer.from("packed-tarball-bytes");
    fs.writeFileSync(tarball, bytes);
    integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  });

  afterAll(() => {
    if (tmp !== "") fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writePack = (extra: Record<string, unknown>) => {
    const file = path.join(tmp, ".dist", "pack.json");
    fs.writeFileSync(file, JSON.stringify({ name: "@duo-director/cli", version: "0.4.0-rc.1", tarball, integrity, ...extra }));
    return file;
  };

  const runCheck = () => spawnSync(process.execPath, [CHECK_SCRIPT, tmp], { cwd: tmp, encoding: "utf8", windowsHide: true });

  it("refuses a pack.json without commit with 'pack again'", () => {
    writePack({});
    const r = runCheck();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pack again");
  });

  it("refuses a pack.json from another commit with 'pack again'", () => {
    writePack({ commit: "0".repeat(40), dirty: false });
    const r = runCheck();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pack again");
  });

  it("refuses a pack.json without the dirty field with 'pack again' (#171)", () => {
    writePack({ commit: head });
    const r = runCheck();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pack again");
  });

  it("refuses a pack made with a tracked edit that was reverted before the check (#171)", async () => {
    const { trackedChanges } = (await import(pathToFileURL(TRACKED_SCRIPT).href)) as { trackedChanges: (root: string) => string[] };
    const source = path.join(tmp, "src.ts");
    const original = fs.readFileSync(source, "utf8");
    fs.writeFileSync(source, "export const value = 2;\n");
    // What pack-cli records at pack time: the tree has a tracked change.
    const atPack = trackedChanges(tmp);
    expect(atPack.length).toBeGreaterThan(0);
    writePack({ commit: head, dirty: atPack.length > 0 });
    fs.writeFileSync(source, original);
    expect(trackedChanges(tmp)).toEqual([]);
    const r = runCheck();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("from a working tree with tracked changes");
    expect(r.stderr).toContain("pack again");
  });

  it("accepts a matching commit regardless of file times", () => {
    const packFile = writePack({ commit: head, dirty: false });
    const past = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(packFile, past, past);
    fs.utimesSync(tarball, past, past);
    const r = runCheck();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("check-packed-artifact: reusing duo-director-cli-0.4.0-rc.1.tgz");
  });
});
