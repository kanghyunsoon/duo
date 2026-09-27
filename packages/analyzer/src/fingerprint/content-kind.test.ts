import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { classifyContentKind } from "./content-kind.js";

describe("classifyContentKind", () => {
  it.each([
    ["src/a.ts", "text"],
    ["src/A.TSX", "text"],
    ["types/index.d.ts", "text"],
    ["package.json", "text"],
    [".duo-project/project.yaml", "text"],
    ["docs/guide.md", "text"],
    [".gitignore", "text"],
    [".eslintrc.json", "text"],
    ["Makefile", "text"],
    ["LICENSE", "text"],
    ["pnpm-lock.yaml", "text"],
    ["assets/logo.png", "binary"],
    ["fonts/a.woff2", "binary"],
    ["graph.db", "binary"],
    ["notes.log", "binary"],
    ["archive.tar.gz", "binary"],
    ["no-extension", "binary"],
    [".hidden", "binary"],
    ["dir.ts/file", "binary"],
  ])("%s is %s", (path, kind) => {
    expect(classifyContentKind(path as RepoPath)).toBe(kind);
  });
});
