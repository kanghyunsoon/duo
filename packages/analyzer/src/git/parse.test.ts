import type { RepoPath } from "@duo-director/core";
import { describe, expect, it } from "vitest";
import {
  GitOutputError, parseLogFiles, parseLogMessages, parseLsFilesStage, parseLsTree, parsePatchBlock, parseRawDiff, parseStatusV2,
  splitPatches, type PathConverter,
} from "./parse.js";

const id: PathConverter = (raw) => (raw.includes("\\") ? undefined : (raw as RepoPath));
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("parseStatusV2 (git status --porcelain=v2 -z)", () => {
  it("reads branch headers, staged/unstaged axes, renames, conflicts and untracked paths with any characters", () => {
    const out = [
      "# branch.oid " + OID_A, "# branch.head main", "# branch.upstream origin/main",
      `1 MM N... 100644 100644 100644 ${OID_A} ${OID_B} tab\tand space.txt`,
      `1 .D N... 100644 100644 000000 ${OID_A} ${OID_A} gone #1.txt`,
      `1 A. S... 000000 160000 160000 ${ZERO} ${OID_B} vendor/sub`,
      `2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R087 new\nline.txt`, "old name.txt",
      `1 T. N... 100644 120000 100644 ${OID_A} ${OID_B} link`,
      `u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${OID_A} 충돌.ts`,
      "? 한글 😀.md", "? nested/", "? back\\slash", "! ignored.log", "",
    ].join("\0");
    const r = parseStatusV2(out, id);
    expect(r.header).toEqual({ oid: OID_A, head: "main" });
    expect(r.skipped).toEqual(["back\\slash"]);
    expect(r.changes).toEqual([
      { path: "tab\tand space.txt", staged: "modified", unstaged: "modified", submodule: false, headMode: "100644", indexMode: "100644", worktreeMode: "100644", headOid: OID_A, indexOid: OID_B },
      { path: "gone #1.txt", unstaged: "deleted", submodule: false, headMode: "100644", indexMode: "100644", headOid: OID_A, indexOid: OID_A },
      { path: "vendor/sub", staged: "added", submodule: true, indexMode: "160000", worktreeMode: "160000", indexOid: OID_B },
      { path: "new\nline.txt", oldPath: "old name.txt", similarity: 87, staged: "renamed", submodule: false, headMode: "100644", indexMode: "100644", worktreeMode: "100644", headOid: OID_A, indexOid: OID_A },
      { path: "link", staged: "type-changed", submodule: false, headMode: "100644", indexMode: "120000", worktreeMode: "100644", headOid: OID_A, indexOid: OID_B },
      { path: "충돌.ts", staged: "unmerged", unstaged: "unmerged", conflict: "UU", submodule: false, worktreeMode: "100644" },
      { path: "한글 😀.md", unstaged: "untracked", submodule: false },
      { path: "nested", unstaged: "untracked", submodule: true },
    ]);
  });

  it("recognizes unborn and detached HEAD", () => {
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head main\0", id).header).toEqual({ head: "main" });
    expect(parseStatusV2(`# branch.oid ${OID_A}\0# branch.head (detached)\0`, id).header).toEqual({ oid: OID_A });
  });

  it("rejects unknown records", () => {
    expect(() => parseStatusV2("x what\0", id)).toThrow(GitOutputError);
  });
});

describe("parseRawDiff + patch blocks (git diff --raw -p -z)", () => {
  const raw = [
    `:100644 100644 ${OID_A} ${OID_B} M`, "a b.txt",
    `:100644 100644 ${OID_A} ${OID_A} R100`, "old\tname", "new #name",
    `:000000 100644 ${ZERO} ${OID_B} A`, "bin.dat",
    `:100644 100644 ${OID_A} ${ZERO} M`, "wt.txt",
    "",
  ].join("\0");
  const patch = [
    "diff --git a/a b.txt b/a b.txt", "index aaaaaaa..bbbbbbb 100644", "--- a/a b.txt", "+++ b/a b.txt",
    "@@ -1,3 +1,4 @@ function f() {", " one", "-two", "+2", " three", "+four",
    "@@ -10 +11,0 @@", "-gone", "\\ No newline at end of file",
    "diff --git a/old\tname b/new #name", "similarity index 100%", "rename from old\tname", "rename to new #name",
    "diff --git a/bin.dat b/bin.dat", "new file mode 100644", "index 0000000..bbbbbbb", "Binary files /dev/null and b/bin.dat differ",
    "diff --git a/wt.txt b/wt.txt", "@@ -1 +1 @@", "-x", "+y", "",
  ].join("\n");
  it("reads records, then pairs patch blocks in order", () => {
    const r = parseRawDiff(raw + "\0" + patch, id);
    expect(r.changes).toEqual([
      { path: "a b.txt", kind: "modified", submodule: false, oldMode: "100644", newMode: "100644", oldOid: OID_A, newOid: OID_B },
      { path: "new #name", oldPath: "old\tname", similarity: 100, kind: "renamed", submodule: false, oldMode: "100644", newMode: "100644", oldOid: OID_A, newOid: OID_A },
      { path: "bin.dat", kind: "added", submodule: false, newMode: "100644", newOid: OID_B },
      { path: "wt.txt", kind: "modified", submodule: false, oldMode: "100644", newMode: "100644", oldOid: OID_A },
    ]);
    const blocks = splitPatches((raw + "\0" + patch).slice(r.end));
    expect(blocks).toHaveLength(4);
    expect(parsePatchBlock(blocks[0] ?? "")).toEqual({
      binary: false,
      hunks: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, section: "function f() {", lines: [" one", "-two", "+2", " three", "+four"] },
        { oldStart: 10, oldLines: 1, newStart: 11, newLines: 0, section: "", lines: ["-gone", "\\ No newline at end of file"] },
      ],
    });
    expect(parsePatchBlock(blocks[1] ?? "")).toEqual({ binary: false, hunks: [] });
    expect(parsePatchBlock(blocks[2] ?? "")).toEqual({ binary: true, hunks: [] });
  });

  it("returns no records for empty output", () => {
    expect(parseRawDiff("", id)).toEqual({ changes: [], skipped: [], end: 0 });
  });
});

describe("ls-tree, ls-files -s and log", () => {
  it("keeps blobs and stage-0 entries only", () => {
    const tree = [`100644 blob ${OID_A}\ta b`, `160000 commit ${OID_B}\tsub`, `120000 blob ${OID_B}\tlink`, ""].join("\0");
    expect([...parseLsTree(tree, id)]).toEqual([["a b", OID_A], ["link", OID_B]]);
    const index = [`100644 ${OID_A} 0\tx`, `100644 ${OID_A} 1\tc`, `100644 ${OID_B} 2\tc`, `160000 ${OID_B} 0\tsub`, ""].join("\0");
    expect([...parseLsFilesStage(index, id)]).toEqual([["x", OID_A], ["c", undefined]]);
  });

  it("parses messages and file lists", () => {
    const messages = [OID_B, OID_A, "second\n\nbody AUTH-03\n", OID_A, "", "first\n", ""].join("\0");
    expect(parseLogMessages(messages)).toEqual([
      { oid: OID_B, parents: [OID_A], message: "second\n\nbody AUTH-03" },
      { oid: OID_A, parents: [], message: "first" },
    ]);
    const files = `\u001e${OID_B}\0\na.txt\0b b.txt\0\u001e${OID_A}\0\na.txt\0`;
    expect([...parseLogFiles(files, id)]).toEqual([[OID_B, ["a.txt", "b b.txt"]], [OID_A, ["a.txt"]]]);
  });
});
