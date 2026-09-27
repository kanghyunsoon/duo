import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { fingerprintModeOf } from "./fingerprint-mode.js";

describe("fingerprintModeOf", () => {
  it.each([
    ["src/a.ts", "normalized-text"],
    ["src/A.TSX", "normalized-text"],
    ["types/index.d.ts", "normalized-text"],
    ["package.json", "normalized-text"],
    [".duo-project/project.yaml", "normalized-text"],
    ["docs/guide.md", "normalized-text"],
    [".gitignore", "normalized-text"],
    [".eslintrc.json", "normalized-text"],
    ["Makefile", "normalized-text"],
    ["LICENSE", "normalized-text"],
    ["pnpm-lock.yaml", "normalized-text"],
    ["assets/logo.png", "raw"],
    ["fonts/a.woff2", "raw"],
    ["graph.db", "raw"],
    ["notes.log", "raw"],
    ["archive.tar.gz", "raw"],
    ["no-extension", "raw"],
    [".hidden", "raw"],
    ["dir.ts/file", "raw"],
  ])("%s is %s", (path, mode) => {
    expect(fingerprintModeOf(path as RepoPath)).toBe(mode);
  });
});
