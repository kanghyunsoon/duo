import { defineConfig } from "vitest/config";

// T17.1 distribution E2E: the packed artifact only (no workspace aliases). Run through pnpm test:dist,
// which packs first.
export default defineConfig({
  test: {
    include: ["tests/distribution/**/*.test.ts"],
    environment: "node",
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
