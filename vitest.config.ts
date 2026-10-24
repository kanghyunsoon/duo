import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFORMANCE_FILES, DEFER_CONFORMANCE_ENV } from "./vitest.conformance-files.js";

// 테스트는 빌드 없이 소스를 직접 읽는다. @duo-director/* 이름을 각 패키지의 src/index.ts로 연결한다.
const packages = ["core", "analyzer", "graph", "director", "integration", "ui"];

// Distribution E2E (packed artifact, npm installs) runs separately: pnpm test:dist.
// The real OpenAI smoke test is opt-in only: pnpm test:openai-smoke (never in CI).
const baseExclude = ["**/node_modules/**", "tests/distribution/**", "tests/openai-smoke/**", "tests/compatible-smoke/**", "tests/ui/ui.accessibility.e2e.test.ts"];

/**
 * T131: in CI the release conformance step of the same job runs CONFORMANCE_FILES against the tarball packed from the
 * same commit, so DUO_TEST_DEFER_CONFORMANCE=1 leaves them to that step (see vitest.conformance-files.ts). Only the
 * value "1" defers; anything else, or unset, runs every file as before.
 */
const deferConformance = process.env[DEFER_CONFORMANCE_ENV] === "1";
const exclude = deferConformance ? [...baseExclude, ...CONFORMANCE_FILES] : baseExclude;
if (deferConformance) {
  process.stderr.write(`pnpm test: ${DEFER_CONFORMANCE_ENV}=1, deferring ${CONFORMANCE_FILES.length} conformance file patterns to the release conformance step: ${CONFORMANCE_FILES.join(", ")}\n`);
}

/**
 * C254 (T52): tests whose duoctl install / doctor launch the product's MCP probe (30 s for spawn, initialize,
 * tools/list and duo_get_status together). They run as a second group, after every other test file has finished,
 * so the probe is not measured against the start-up storm of the whole parallel suite. The probe timeout is unchanged.
 */
const agentLaunch = ["tests/install/install.e2e.test.ts", "tests/install/launcher.e2e.test.ts", "tests/cli/doctor.e2e.test.ts"];
/** The agent-launch files pnpm test still runs; empty when they are all deferred to release conformance. */
const agentLaunchRun = agentLaunch.filter((file) => !(deferConformance && CONFORMANCE_FILES.some((glob) => path.matchesGlob(file, glob))));

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
    ),
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "duo",
          include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts", "bench/value-validation/**/*.test.mjs"],
          exclude: [...exclude, ...agentLaunch],
          sequence: { groupOrder: 0 },
        },
      },
      ...(agentLaunchRun.length === 0 ? [] : [{ extends: true, test: { name: "agent-launch", include: agentLaunchRun, exclude, sequence: { groupOrder: 1 } } }]),
    ],
  },
});
