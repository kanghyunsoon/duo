// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import boundaries from "./scripts/boundaries.json" with { type: "json" };

/** ADR-010: 패키지 의존 방향, ADR-002: node:sqlite 격리, REQ-CLI-001: 얇은 CLI. */
const TS = "**/*.{ts,mts,cts,tsx}";
const packages = /** @type {Record<string, {dir: string, allow: string[], typeOnly: string[]}>} */ (boundaries.packages);
const names = Object.keys(packages);
const dirs = Object.values(packages).map((p) => p.dir.split("/")[1]);

/**
 * @param {string} name
 * @param {{ sqliteAllowed?: boolean, cliNode?: boolean }} [opts]
 */
function restrictions(name, opts = {}) {
  const spec = packages[name];
  if (!spec) throw new Error(`unknown package ${name}`);
  const forbidden = names.filter((n) => n !== name && !spec.allow.includes(n) && !spec.typeOnly.includes(n));
  const paths = [
    ...spec.typeOnly.map((n) => ({
      name: n,
      allowTypeImports: true,
      message: `${name} may import only types from ${n} (ADR-010).`,
    })),
    ...(opts.sqliteAllowed ? [] : [{
      name: "node:sqlite",
      message: `node:sqlite is allowed only in ${boundaries.nodeSqliteAllowed}/ (ADR-002).`,
    }]),
    ...(opts.cliNode ? boundaries.cliForbiddenNodeModules.filter((m) => m !== "node:sqlite").map((m) => ({
      name: m,
      message: "apps/cli is a thin entry point; do I/O through packages (REQ-CLI-001).",
    })) : []),
  ];
  const patterns = [
    {
      group: forbidden.flatMap((n) => [n, `${n}/*`]),
      message: `${name} must not depend on this package (ADR-010 dependency direction).`,
    },
    {
      regex: `^(\\.\\./)+(packages/|apps/)?(${dirs.join("|")})/src(/|$)`,
      message: "Import other workspace packages by name, not by relative path (ADR-010).",
    },
  ];
  return ["error", { paths, patterns }];
}

const RULE = "@typescript-eslint/no-restricted-imports";

export default defineConfig(
  { ignores: ["**/dist/**", "**/coverage/**", "tmp/**", ".worklog/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.node } },
  { files: [TS], rules: { "no-restricted-imports": "off" } },
  ...names.map((name) => ({
    files: [`${packages[name]?.dir}/${TS}`],
    rules: { [RULE]: restrictions(name) },
  })),
  {
    files: [`apps/cli/src/${TS}`],
    ignores: ["**/*.test.ts"],
    rules: { [RULE]: restrictions("@duo/cli", { cliNode: true }) },
  },
  {
    files: [`${boundaries.nodeSqliteAllowed}/${TS}`],
    rules: { [RULE]: restrictions("@duo/graph", { sqliteAllowed: true }) },
  },
);
