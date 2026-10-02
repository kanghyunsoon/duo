import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// T27.1 opt-in live smoke of the openai-compatible provider against an endpoint the user names. Runs only through
// pnpm test:compatible-smoke and skips (no network) unless every DUO_COMPATIBLE_SMOKE_* setting is given. Never in CI.
const packages = ["core", "analyzer", "graph", "director", "integration"];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))])),
  },
  test: { include: ["tests/compatible-smoke/**/*.test.ts"], environment: "node", testTimeout: 120_000 },
});
