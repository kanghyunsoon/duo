import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRepoPath, normalizeRepoPattern, toRepoPath } from "./paths.js";

const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

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

  it.each(["", "   ", ".", "./"])("rejects %j as a file path", (input) => {
    expect(codes(normalizeRepoPath(input))).toEqual(["INVALID_PATH"]);
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
