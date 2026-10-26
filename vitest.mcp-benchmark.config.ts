import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/bench/mcp-benchmark.test.ts"],
    environment: "node",
  },
});
