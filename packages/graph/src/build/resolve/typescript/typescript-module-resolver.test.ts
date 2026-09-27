import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoPath } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { createTypeScriptModuleResolver, TYPESCRIPT_MODULE_RESOLUTION_VERSION, TYPESCRIPT_VERSION } from "./typescript-module-resolver.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

function project(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-tsres-")));
  temps.push(root);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  const indexed = new Set(Object.keys(files).filter((f) => !f.startsWith("node_modules/")) as RepoPath[]);
  const resolver = createTypeScriptModuleResolver({ root, indexedFiles: indexed });
  const resolve = (fromPath: string, specifier: string, kind: "import" | "require" | "dynamic-import" | "export-from" = "import") =>
    resolver.resolve({ fromPath: fromPath as RepoPath, specifier, kind });
  return { root, resolver, resolve };
}

const NODE_NEXT = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", paths: { "@lib/*": ["./src/lib/*"] }, allowJs: true } }),
  "package.json": JSON.stringify({ name: "app", type: "module", imports: { "#util": "./src/util.ts" } }),
  "src/a.ts": "", "src/foo.ts": "", "src/dir/index.ts": "", "src/lib/x.ts": "", "src/util.ts": "", "src/types.d.ts": "",
  "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
  "node_modules/pkg/index.d.ts": "", "node_modules/pkg/index.js": "",
};

describe("TypeScriptModuleResolver on TypeScript 6 (contract fixed here; upgrades must show up)", () => {
  it("runs on TypeScript 6.0", () => {
    expect(TYPESCRIPT_VERSION).toMatch(/^6\.0\./);
    // Stored resolutions are recomputed when the adapter rules or the TypeScript version change (TASK-008).
    expect(TYPESCRIPT_MODULE_RESOLUTION_VERSION).toBe(`1+typescript-${TYPESCRIPT_VERSION}`);
  });

  it("NodeNext: .js specifier → .ts source, extensionless and directory imports stay unresolved", () => {
    const { resolve } = project(NODE_NEXT);
    expect(resolve("src/a.ts", "./foo.js")).toEqual({ status: "resolved", path: "src/foo.ts", claim: "typescript-resolution", declarationOnly: false, extensionSubstituted: true, configPath: "tsconfig.json" });
    expect(resolve("src/a.ts", "./dir/index.js")).toMatchObject({ status: "resolved", path: "src/dir/index.ts" });
    expect(resolve("src/a.ts", "./foo")).toEqual({ status: "unresolved", reason: "not-found" });
    expect(resolve("src/a.ts", "./dir")).toEqual({ status: "unresolved", reason: "not-found" });
  });

  it("paths, package.json imports, declaration files", () => {
    const { resolve } = project(NODE_NEXT);
    expect(resolve("src/a.ts", "@lib/x.js")).toMatchObject({ status: "resolved", path: "src/lib/x.ts" });
    expect(resolve("src/a.ts", "#util")).toMatchObject({ status: "resolved", path: "src/util.ts", extensionSubstituted: false });
    expect(resolve("src/a.ts", "./types.js")).toMatchObject({ status: "resolved", path: "src/types.d.ts", declarationOnly: true });
  });

  it("external packages, builtins, URLs and missing modules", () => {
    const { resolve } = project(NODE_NEXT);
    expect(resolve("src/a.ts", "pkg")).toEqual({ status: "external", reason: "package" });
    expect(resolve("src/a.ts", "not-installed")).toEqual({ status: "external", reason: "package" });
    expect(resolve("src/a.ts", "node:fs")).toEqual({ status: "external", reason: "builtin" });
    expect(resolve("src/a.ts", "fs/promises")).toEqual({ status: "external", reason: "builtin" });
    expect(resolve("src/a.ts", "https://example.com/x.js")).toEqual({ status: "unsupported", reason: "URL specifier" });
    expect(resolve("src/a.ts", "./missing.js")).toEqual({ status: "unresolved", reason: "not-found" });
  });

  it("does not turn a repository file that is not indexed into a node", () => {
    const { root, resolver } = project(NODE_NEXT);
    fs.writeFileSync(path.join(root, "src", "ignored.ts"), "");
    expect(resolver.resolve({ fromPath: "src/a.ts" as RepoPath, specifier: "./ignored.js", kind: "import" })).toEqual({ status: "unresolved", reason: "not-indexed" });
  });

  it("Bundler: extensionless paths, index files and baseUrl", () => {
    const { resolve } = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", baseUrl: "src" } }),
      "src/a.ts": "", "src/foo.ts": "", "src/dir/index.ts": "", "src/lib/x.ts": "",
    });
    expect(resolve("src/a.ts", "./foo")).toMatchObject({ status: "resolved", path: "src/foo.ts", extensionSubstituted: false });
    expect(resolve("src/a.ts", "./dir")).toMatchObject({ status: "resolved", path: "src/dir/index.ts" });
    expect(resolve("src/a.ts", "lib/x")).toMatchObject({ status: "resolved", path: "src/lib/x.ts" });
  });

  it("nearest config wins, extends is followed, jsconfig is used for JavaScript projects", () => {
    const { resolve, resolver } = project({
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "~/*": ["./shared/*"] } } }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "shared/s.ts": "", "src/a.ts": "",
      "web/jsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@w/*": ["./lib/*"] } } }),
      "web/lib/w.js": "", "web/app.js": "",
    });
    expect(resolve("src/a.ts", "~/s")).toMatchObject({ status: "resolved", path: "shared/s.ts", configPath: "tsconfig.json" });
    expect(resolve("web/app.js", "@w/w")).toMatchObject({ status: "resolved", path: "web/lib/w.js", configPath: "web/jsconfig.json" });
    expect(resolve("web/app.js", "~/s")).toEqual({ status: "external", reason: "package" });
    // Config dependencies: the nearest config and the files it extends.
    expect(resolver.configFiles("src/a.ts" as RepoPath)).toEqual(["tsconfig.json", "tsconfig.base.json"]);
    expect(resolver.configFiles("web/app.js" as RepoPath)).toEqual(["web/jsconfig.json"]);
  });

  it("without any config resolves relative local modules only", () => {
    const { resolve, resolver } = project({ "src/a.js": "", "src/b.js": "", "src/dir/index.js": "" });
    expect(resolver.configFiles("src/a.js" as RepoPath)).toEqual([]);
    expect(resolve("src/a.js", "./b")).toMatchObject({ status: "resolved", path: "src/b.js" });
    expect(resolve("src/a.js", "./dir")).toMatchObject({ status: "resolved", path: "src/dir/index.js" });
    expect(resolve("src/a.js", "react")).toEqual({ status: "external", reason: "package" });
    expect(resolve("src/a.js", "./b", "require")).toMatchObject({ status: "resolved", path: "src/b.js" });
  });

  it("reports an invalid tsconfig", () => {
    const { resolver } = project({ "tsconfig.json": "{ \"compilerOptions\": { \"moduleResolution\": \"nope\" } }", "a.ts": "" });
    resolver.resolve({ fromPath: "a.ts" as RepoPath, specifier: "./b", kind: "import" });
    expect(resolver.diagnostics.map((d) => d.code)).toContain("TSCONFIG_INVALID");
  });
});
