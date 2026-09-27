import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "@typescript-eslint/no-restricted-imports";
const eslint = new ESLint({ cwd: root });

async function violations(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).length;
}

describe("AC-001-02 lint enforces the ADR-010 dependency direction", () => {
  const cases: [string, string, string, boolean][] = [
    ["core cannot import graph", "packages/core/src/probe.ts", 'import { packageInfo } from "@duo/graph";', false],
    ["analyzer may import core", "packages/analyzer/src/probe.ts", 'import { packageInfo } from "@duo/core";', true],
    ["director cannot import integration", "packages/director/src/probe.ts", 'import { packageInfo } from "@duo/integration";', false],
    ["integration cannot import analyzer", "packages/integration/src/probe.ts", 'import { packageInfo } from "@duo/analyzer";', false],
    ["ui may import core types", "packages/ui/src/probe.ts", 'import type { PackageInfo } from "@duo/core";', true],
    ["ui cannot import core values", "packages/ui/src/probe.ts", 'import { packageInfo } from "@duo/core";', false],
    ["no relative import into another package", "packages/core/src/probe.ts", 'import { packageInfo } from "../../graph/src/index.js";', false],
    ["graph cannot import node:sqlite outside the store", "packages/graph/src/probe.ts", 'import { DatabaseSync } from "node:sqlite";', false],
    ["NodeSqliteGraphStore may import node:sqlite", "packages/graph/src/store/node-sqlite/probe.ts", 'import { DatabaseSync } from "node:sqlite";', true],
    ["director cannot import node:sqlite", "packages/director/src/probe.ts", 'import { DatabaseSync } from "node:sqlite";', false],
    ["cli cannot do file I/O directly", "apps/cli/src/probe.ts", 'import { readFileSync } from "node:fs";', false],
    ["cli may import packages", "apps/cli/src/probe.ts", 'import { packageInfo } from "@duo/integration";', true],
    ["core domain cannot import the YAML library", "packages/core/src/domain/probe.ts", 'import { parseDocument } from "yaml";', false],
    ["core domain cannot import mdast types", "packages/core/src/domain/probe.ts", 'import type { Root } from "mdast";', false],
    ["core source layer may import the YAML library", "packages/core/src/source/probe.ts", 'import { parseDocument } from "yaml";', true],
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
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, dependencies: { "@duo/graph": "workspace:*" } }));
    const result = runCheck(temp);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("@duo/core: dependencies -> @duo/graph");
  });
});
