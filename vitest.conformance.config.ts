import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// TASK-020 release conformance: the subprocess journeys (CLI, MCP, agent install) plus the RC-only checks,
// run against the installed release candidate. Started by scripts/release/conformance.mjs, which installs the
// tarball and sets DUO_CONFORMANCE_CLI / DUO_CONFORMANCE_PREFIX. Tests that call workspace code directly
// (cli.tty, ui.browser, unit tests) are not part of it.
const packages = ["core", "analyzer", "graph", "director", "integration", "ui"];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))])),
  },
  test: {
    include: [
      "tests/cli/existing-project.e2e.test.ts", "tests/cli/first-run.e2e.test.ts", "tests/cli/languages.e2e.test.ts", "tests/cli/semantic.e2e.test.ts", "tests/cli/ui.e2e.test.ts",
      "tests/cli/doctor.e2e.test.ts", "tests/cli/compatible.e2e.test.ts",
      "tests/mcp/**/*.e2e.test.ts", "tests/install/**/*.e2e.test.ts", "tests/conformance/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
