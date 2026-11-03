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
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@duo-director/core";
import { DEFER_CONFORMANCE_ENV } from "../../vitest.conformance-files.js";

type Env = Readonly<Record<string, unknown>>;
interface Step { readonly name?: string; readonly run?: string; readonly shell?: unknown; readonly if?: unknown; readonly env?: Env; readonly "continue-on-error"?: unknown }
interface Job { readonly steps?: readonly Step[]; readonly env?: Env; readonly "continue-on-error"?: unknown }
const parsed = parseYaml({ path: ".github/workflows/ci.yml", text: fs.readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8") });
if (parsed.value === undefined) throw new Error(JSON.stringify(parsed.diagnostics));
const workflow = parsed.value.data as { env?: Env; jobs: Record<string, Job> };

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
      expect(conformance.shell, "the conformance step must use the default shell").toBeUndefined();
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
});
