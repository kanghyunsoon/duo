/**
 * The files release conformance runs against the installed release candidate (vitest.conformance.config.ts, started
 * by scripts/release/conformance.mjs with DUO_CONFORMANCE_CLI). Plain pnpm test runs the same files against the
 * workspace build. Both configurations read this one list, so they cannot drift apart.
 */
export const CONFORMANCE_FILES = [
  "tests/cli/existing-project.e2e.test.ts", "tests/cli/first-run.e2e.test.ts", "tests/cli/languages.e2e.test.ts", "tests/cli/semantic.e2e.test.ts", "tests/cli/ui.e2e.test.ts",
  "tests/cli/doctor.e2e.test.ts", "tests/cli/compatible.e2e.test.ts",
  "tests/mcp/**/*.e2e.test.ts", "tests/install/**/*.e2e.test.ts", "tests/conformance/**/*.test.ts",
];

/**
 * T131 (CI): with DUO_TEST_DEFER_CONFORMANCE=1, pnpm test leaves CONFORMANCE_FILES to the release conformance step of
 * the same CI job, which runs them against the tarball packed from the same commit. Their assertions are unchanged and
 * still run on every OS; they just do not run twice. Unset (local runs, release tooling), pnpm test runs everything.
 */
export const DEFER_CONFORMANCE_ENV = "DUO_TEST_DEFER_CONFORMANCE";
