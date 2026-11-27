import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFORMANCE_FILES, MCP_RECOVERY_FILE } from "./vitest.conformance-files.js";

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
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    projects: [
      {
        extends: true,
        test: {
          name: "conformance",
          include: CONFORMANCE_FILES,
          exclude: [MCP_RECOVERY_FILE],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: "mcp-recovery", include: [MCP_RECOVERY_FILE], sequence: { groupOrder: 1 } },
      },
    ],
  },
});
