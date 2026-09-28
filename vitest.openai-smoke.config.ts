import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// T12B opt-in smoke test against the real OpenAI API. Runs only through pnpm test:openai-smoke and
// skips unless DUO_OPENAI_SMOKE=1, OPENAI_API_KEY and DUO_OPENAI_SMOKE_MODEL are set. Never in CI.
const packages = ["core", "analyzer", "graph", "director", "integration"];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))])),
  },
  test: { include: ["tests/openai-smoke/**/*.test.ts"], environment: "node", testTimeout: 120_000 },
});
