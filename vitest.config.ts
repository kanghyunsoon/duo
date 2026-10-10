import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 테스트는 빌드 없이 소스를 직접 읽는다. @duo-director/* 이름을 각 패키지의 src/index.ts로 연결한다.
const packages = ["core", "analyzer", "graph", "director", "integration", "ui"];

// Distribution E2E (packed artifact, npm installs) runs separately: pnpm test:dist.
// The real OpenAI smoke test is opt-in only: pnpm test:openai-smoke (never in CI).
const exclude = ["**/node_modules/**", "tests/distribution/**", "tests/openai-smoke/**", "tests/compatible-smoke/**"];

/**
 * C254 (T52): tests whose duoctl install / doctor launch the product's MCP probe (30 s for spawn, initialize,
 * tools/list and duo_get_status together). They run as a second group, after every other test file has finished,
 * so the probe is not measured against the start-up storm of the whole parallel suite. The probe timeout is unchanged.
 */
const agentLaunch = ["tests/install/install.e2e.test.ts", "tests/cli/doctor.e2e.test.ts"];

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
          include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: [...exclude, ...agentLaunch],
          sequence: { groupOrder: 0 },
        },
      },
      { extends: true, test: { name: "agent-launch", include: agentLaunch, exclude, sequence: { groupOrder: 1 } } },
    ],
  },
});
