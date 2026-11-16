import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = ["core", "analyzer", "graph", "director", "integration", "ui"];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
    ),
  },
  test: {
    environment: "node",
    include: ["tests/ui/ui.accessibility.e2e.test.ts", "tests/ui/ui-a11y-artifacts.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
