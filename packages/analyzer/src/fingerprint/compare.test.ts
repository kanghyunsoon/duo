import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import { compareFingerprints } from "./compare.js";
import type { FileFingerprint } from "./fingerprint.js";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const fp = (path: string, hash: string, extra: Partial<FileFingerprint> = {}): FileFingerprint =>
  ({ path: path as RepoPath, state: "tracked", kind: "text", contentHash: h(hash), size: 1, ...extra });

describe("compareFingerprints", () => {
  it("classifies every path as UNCHANGED, CHANGED, ADDED or DELETED in UTF-8 order", () => {
    const previous = [fp("same.ts", "a"), fp("edit.ts", "b"), fp("gone.ts", "c"), fp("\u{1F600}.ts", "d"), fp("\uFF5E.ts", "e")];
    const current = [fp("new.ts", "f"), fp("edit.ts", "0"), fp("same.ts", "a"), fp("\u{1F600}.ts", "d"), fp("\uFF5E.ts", "1")];
    expect(compareFingerprints(previous, current).map((c) => [c.path, c.status])).toEqual([
      ["edit.ts", "CHANGED"],
      ["gone.ts", "DELETED"],
      ["new.ts", "ADDED"],
      ["same.ts", "UNCHANGED"],
      ["\uFF5E.ts", "CHANGED"],
      ["\u{1F600}.ts", "UNCHANGED"],
    ]);
  });

  it("ignores state, size and gitBlobOid; compares content hash and kind", () => {
    const a = fp("a.ts", "a", { state: "untracked" });
    const b = fp("a.ts", "a", { state: "tracked", gitBlobOid: "0".repeat(40), size: 99 });
    expect(compareFingerprints([a], [b])).toEqual([{ path: "a.ts", status: "UNCHANGED", previous: a, current: b }]);
    expect(compareFingerprints([a], [fp("a.ts", "a", { kind: "binary" })])[0]?.status).toBe("CHANGED");
  });

  it("treats a rename as DELETED + ADDED", () => {
    expect(compareFingerprints([fp("old.ts", "a")], [fp("new.ts", "a")]).map((c) => c.status)).toEqual(["ADDED", "DELETED"]);
  });
});
