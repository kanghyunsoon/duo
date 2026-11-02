/**
 * T131 guard (#83 review): with DUO_TEST_DEFER_CONFORMANCE=1, pnpm test skips the conformance files and leaves them to
 * the release conformance step of the same CI job. If that step disappeared, ran with --skip-e2e, or could fail without
 * failing the job, the 13 deferred files (118 tests) would silently stop running while CI stays green. This test reads
 * .github/workflows/ci.yml and fails in that case, so pnpm test catches it before such a workflow change merges.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@duo-director/core";
import { DEFER_CONFORMANCE_ENV } from "../../vitest.conformance-files.js";

interface Step { readonly name?: string; readonly run?: string; readonly if?: unknown; readonly env?: Record<string, unknown>; readonly "continue-on-error"?: unknown }
interface Job { readonly steps?: readonly Step[]; readonly "continue-on-error"?: unknown }
const parsed = parseYaml({ path: ".github/workflows/ci.yml", text: fs.readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8") });
if (parsed.value === undefined) throw new Error(JSON.stringify(parsed.diagnostics));
const workflow = parsed.value.data as { jobs: Record<string, Job> };

const defers = (step: Step) => String(step.env?.[DEFER_CONFORMANCE_ENV] ?? "") === "1";
const runsConformance = (step: Step) => /(?:^|\s|&&)node scripts\/release\/conformance\.mjs(?:\s|$)|pnpm (?:run )?test:conformance(?:\s|$)/mu.test(step.run ?? "");

describe("CI defers conformance files only to a conformance step that runs them (T131)", () => {
  const deferring = Object.entries(workflow.jobs).filter(([, job]) => (job.steps ?? []).some(defers));

  it("the ci workflow defers them in at least one job", () => {
    expect(deferring.map(([id]) => id)).not.toEqual([]);
  });

  for (const [id, job] of deferring) {
    it(id + ": a later, unconditional step runs the full conformance suite against the packed tarball", () => {
      const steps = job.steps ?? [];
      const deferredAt = steps.findIndex(defers);
      const conformanceAt = steps.findIndex((step, i) => i > deferredAt && runsConformance(step));
      expect(conformanceAt, "no step after the deferring pnpm test runs scripts/release/conformance.mjs").toBeGreaterThan(deferredAt);
      const conformance = steps[conformanceAt] as Step;
      expect(conformance.run).not.toContain("--skip-e2e");
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
