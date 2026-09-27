import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 테스트는 빌드 없이 소스를 직접 읽는다. @duo-director/* 이름을 각 패키지의 src/index.ts로 연결한다.
const packages = ["core", "analyzer", "graph", "director", "integration", "ui"];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((p) => [`@duo-director/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
    ),
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
