import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "@typescript-eslint/no-restricted-imports";
const eslint = new ESLint({ cwd: root });

// The first lintText loads the flat config and plugins (seconds on a busy Windows runner).
// Pay that once here so each case measures only its own lint.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: join(root, "packages/core/src/probe.ts") });
}, 60_000);

async function violations(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).length;
}

describe("AC-001-02 lint enforces the ADR-010 dependency direction", () => {
  const cases: [string, string, string, boolean][] = [
    ["core cannot import graph", "packages/core/src/probe.ts", 'import { packageInfo } from "@duo-director/graph";', false],
    ["analyzer may import core", "packages/analyzer/src/probe.ts", 'import { packageInfo } from "@duo-director/core";', true],
    ["director cannot import integration", "packages/director/src/probe.ts", 'import { packageInfo } from "@duo-director/integration";', false],
    ["integration may import analyzer (TASK-016: Git root check, analyzer registry)", "packages/integration/src/probe.ts", 'import { packageInfo } from "@duo-director/analyzer";', true],
    ["ui cannot import integration", "packages/ui/src/probe.ts", 'import { packageInfo } from "@duo-director/integration";', false],
    ["director cannot import the MCP SDK", "packages/director/src/probe.ts", 'import { McpServer } from "@modelcontextprotocol/server";', false],
    ["shared operations cannot import the MCP SDK", "packages/integration/src/operations/probe.ts", 'import { McpServer } from "@modelcontextprotocol/server";', false],
    ["the MCP adapter may import the MCP SDK", "packages/integration/src/mcp/probe.ts", 'import { McpServer } from "@modelcontextprotocol/server";', true],
    ["the agent installer cannot import the MCP SDK (it uses mcp/probe)", "packages/integration/src/agents/probe.ts", 'import { Client } from "@modelcontextprotocol/client";', false],
    ["the TOML parser is a normal dependency of integration", "packages/integration/src/agents/probe.ts", 'import { parse } from "smol-toml";', true],
    ["ui may import core types", "packages/ui/src/probe.ts", 'import type { PackageInfo } from "@duo-director/core";', true],
    ["ui cannot import core values", "packages/ui/src/probe.ts", 'import { packageInfo } from "@duo-director/core";', false],
    ["no relative import into another package", "packages/core/src/probe.ts", 'import { packageInfo } from "../../graph/src/index.js";', false],
    ["graph cannot import node:sqlite outside the store", "packages/graph/src/probe.ts", 'import { DatabaseSync } from "node:sqlite";', false],
    ["NodeSqliteGraphStore may import node:sqlite", "packages/graph/src/store/node-sqlite/probe.ts", 'import { DatabaseSync } from "node:sqlite";', true],
    ["director cannot import node:sqlite", "packages/director/src/probe.ts", 'import { DatabaseSync } from "node:sqlite";', false],
    ["cli cannot do file I/O directly", "apps/cli/src/probe.ts", 'import { readFileSync } from "node:fs";', false],
    ["cli may import packages", "apps/cli/src/probe.ts", 'import { packageInfo } from "@duo-director/integration";', true],
    ["core domain cannot import the YAML library", "packages/core/src/domain/probe.ts", 'import { parseDocument } from "yaml";', false],
    ["core domain cannot import mdast types", "packages/core/src/domain/probe.ts", 'import type { Root } from "mdast";', false],
    ["core source layer may import the YAML library", "packages/core/src/source/probe.ts", 'import { parseDocument } from "yaml";', true],
    ["analyzer contract cannot import web-tree-sitter", "packages/analyzer/src/language/probe.ts", 'import type { Node } from "web-tree-sitter";', false],
    ["analyzer scanner cannot import web-tree-sitter", "packages/analyzer/src/scan/probe.ts", 'import { Parser } from "web-tree-sitter";', false],
    ["analyzer tree-sitter layer may import web-tree-sitter", "packages/analyzer/src/language/tree-sitter/probe.ts", 'import { Parser } from "web-tree-sitter";', true],
    ["graph builder cannot import the TypeScript API", "packages/graph/src/build/probe.ts", 'import ts from "typescript";', false],
    ["TypeScriptModuleResolver may import the TypeScript API", "packages/graph/src/build/resolve/typescript/probe.ts", 'import ts from "typescript";', true],
  ];
  for (const [name, file, code, allowed] of cases) {
    it(name, async () => {
      const count = await violations(file, code + "\nexport {};\n");
      expect(count === 0).toBe(allowed);
    });
  }
});

describe("AC-001-02 check-boundaries validates package manifests", () => {
  const script = join(root, "scripts", "check-boundaries.mjs");
  const temp = mkdtempSync(join(tmpdir(), "duo-boundaries-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const runCheck = (workspace: string) => {
    try {
      execFileSync(process.execPath, [script, "--root", workspace], { stdio: "pipe" });
      return { code: 0, stderr: "" };
    } catch (e) {
      const err = e as { status: number; stderr: Buffer };
      return { code: err.status, stderr: err.stderr.toString() };
    }
  };

  it("passes on this repository", () => {
    expect(runCheck(root).code).toBe(0);
  });

  it("fails when core declares a dependency on graph", () => {
    for (const dir of ["packages", "apps"]) {
      cpSync(join(root, dir), join(temp, dir), {
        recursive: true,
        filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src),
      });
    }
    const pkgPath = join(temp, "packages", "core", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, dependencies: { "@duo-director/graph": "workspace:*" } }));
    const result = runCheck(temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("@duo-director/core: dependencies -> @duo-director/graph");
  });
});
