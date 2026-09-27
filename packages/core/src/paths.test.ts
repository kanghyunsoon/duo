import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileRepoPattern, findPathPortabilityCollisions, matchesRepoPattern, normalizeRepoPath, normalizeRepoPattern, portablePathKey, toRepoPath,
  type RepoPath,
} from "./paths.js";

const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe("matchesRepoPattern", () => {
  const p = (s: string) => s as RepoPath;
  it.each([
    ["src/**", "src/a.ts", true],
    ["src/**", "src/a/b/c.ts", true],
    ["src/**", "src", false],
    ["src/", "src/a/b.ts", true],
    ["src\\auth\\**", "src/auth/x.ts", true],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "src/deep/a.test.ts", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/**/b.ts", "src/b.ts", true],
    ["src/**/b.ts", "src/x/y/b.ts", true],
    ["a?.ts", "ab.ts", true],
    ["a?.ts", "a/.ts", false],
    ["a?.ts", "a\u{1F600}.ts", true],
    ["docs/(x).md", "docs/(x).md", true],
    ["docs/a+b.md", "docs/aab.md", false],
    ["Src/**", "src/a.ts", false],
    ["*.log", "logs/a.log", false],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(matchesRepoPattern(p(path), pattern)).toBe(expected);
  });

  it("rejects patterns that leave the repository", () => {
    expect(compileRepoPattern("../x/**")).toBeUndefined();
    expect(compileRepoPattern("/abs/**")).toBeUndefined();
    expect(matchesRepoPattern(p("x/a.ts"), "../x/**")).toBe(false);
  });
});

describe("normalizeRepoPath", () => {
  it.each([
    ["src\\auth\\AuthService.ts", "src/auth/AuthService.ts"],
    ["./src//auth/./AuthService.ts", "src/auth/AuthService.ts"],
    ["src/auth/", "src/auth"],
    ["docs/../src/a.ts", "src/a.ts"],
  ])("AC-002-05 %s → %s", (input, expected) => {
    expect(normalizeRepoPath(input).value).toBe(expected);
  });

  it("AC-002-05 makes Windows absolute paths relative to a Windows root on any OS", () => {
    expect(normalizeRepoPath("C:\\work\\duo\\src\\a.ts", { root: "C:\\work\\duo" }).value).toBe("src/a.ts");
    expect(normalizeRepoPath("c:\\Work\\Duo\\src\\a.ts", { root: "C:\\work\\duo" }).value).toBe("src/a.ts");
  });

  it("makes POSIX absolute paths relative to a POSIX root on any OS", () => {
    expect(normalizeRepoPath("/home/u/duo/src/a.ts", { root: "/home/u/duo" }).value).toBe("src/a.ts");
  });

  it.each(["/etc/passwd", "C:\\repo\\a.ts", "\\\\server\\share\\a.ts"])("rejects absolute path %s without a root", (input) => {
    const r = normalizeRepoPath(input);
    expect(r.value).toBeUndefined();
    expect(codes(r)).toEqual(["INVALID_PATH"]);
  });

  it.each([
    ["../secret.txt", {}],
    ["src/../../x", {}],
    ["C:\\other\\a.ts", { root: "C:\\work\\duo" }],
    ["D:\\a.ts", { root: "C:\\work\\duo" }],
  ])("rejects %s outside the repository", (input, options) => {
    expect(codes(normalizeRepoPath(input, options))).toEqual(["PATH_OUTSIDE_REPOSITORY"]);
  });

  it.each(["", ".", "./"])("rejects %j as a file path", (input) => {
    expect(codes(normalizeRepoPath(input))).toEqual(["INVALID_PATH"]);
  });

  it("preserves spelling: letter case, Unicode normalization and spaces are not rewritten", () => {
    for (const p of ["src/Auth.ts", "src/cafe\u0301.ts", "src/caf\u00e9.ts", " spaced name .ts"]) {
      expect(normalizeRepoPath(p).value).toBe(p);
    }
  });
});

describe("normalizeRepoPattern", () => {
  it("converts separators and keeps glob segments", () => {
    expect(normalizeRepoPattern("src\\auth\\**").value).toBe("src/auth/**");
    expect(normalizeRepoPattern("./src//auth/*.ts").value).toBe("src/auth/*.ts");
  });

  it("rejects absolute and traversal patterns", () => {
    expect(codes(normalizeRepoPattern("C:\\src\\**"))).toEqual(["INVALID_PATH"]);
    expect(codes(normalizeRepoPattern("../secrets/**"))).toEqual(["PATH_OUTSIDE_REPOSITORY"]);
  });
});

describe("toRepoPath", () => {
  it("AC-002-05 converts host paths under the root to POSIX repository paths", () => {
    const root = path.resolve("repo-root");
    expect(toRepoPath(root, path.join(root, "src", "auth", "a.ts")).value).toBe("src/auth/a.ts");
    expect(codes(toRepoPath(root, path.resolve("elsewhere", "a.ts")))).toEqual(["PATH_OUTSIDE_REPOSITORY"]);
  });
});

describe("path portability collisions (contract for the T04 scanner)", () => {
  const rp = (...p: string[]) => p as RepoPath[];

  it("reports paths that differ only by letter case", () => {
    const [d] = findPathPortabilityCollisions(rp("src/Auth.ts", "src/auth.ts", "src/other.ts"));
    expect(d).toMatchObject({ code: "PATH_PORTABILITY_COLLISION", severity: "warning", source: { path: "src/Auth.ts" } });
    expect(d?.message).toContain("letter case");
    expect(d?.message).toContain("src/Auth.ts, src/auth.ts");
  });

  it("reports NFC and NFD spellings of the same name", () => {
    const [d] = findPathPortabilityCollisions(rp("src/caf\u00e9.ts", "src/cafe\u0301.ts"));
    expect(d?.message).toContain("Unicode normalization");
  });

  it("reports nothing for distinct paths and uses a key that is never stored", () => {
    expect(findPathPortabilityCollisions(rp("src/a.ts", "src/b.ts", "src/a.ts"))).toEqual([]);
    expect(portablePathKey("src/Caf\u00c9.ts" as RepoPath)).toBe(portablePathKey("src/cafe\u0301.ts" as RepoPath));
  });
});
