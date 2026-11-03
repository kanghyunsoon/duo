import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CONFORMANCE_FILES } from "./vitest.conformance-files.js";

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
    include: CONFORMANCE_FILES,
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
