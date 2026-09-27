import fs from "node:fs";
import path from "node:path";
import type { RepoPath } from "@duo-director/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTempRepo, makeTempDir, removeTempDirs, type TempRepo } from "../testing/git-repo.js";
import { computeCoChangeCandidates, extractIssueKeys } from "./history.js";
import { openGitProvider, type GitProvider } from "./provider.js";

afterAll(removeTempDirs);
// Each test spawns several git processes; process start-up is slow on Windows CI runners.
vi.setConfig({ testTimeout: 30_000 });

const p = (s: string) => s as RepoPath;
// Fixed content, author and date (testing/git-repo.ts): the same commit IDs on every OS.
const C1 = "e9de8584a711b18d78755106e4dd390dcbb75166";
const C2 = "4f358924fdc6ed39abd18dc480e96d3bb4a95523";
const A_V2 = "ea14db2cbfbc66490839aedb0930134deee503ad";
const BB = "af9c6fd168ea28cf99aa2c2dd9057a8b720e2262";

async function provider(repo: TempRepo): Promise<GitProvider> {
  const r = await openGitProvider(repo.root);
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}
async function value<T>(promise: Promise<{ value?: T; diagnostics: readonly { code: string }[] }>): Promise<T> {
  const r = await promise;
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  expect(r.diagnostics).toEqual([]);
  return r.value;
}
/** Two commits: C1 (a.txt, "b b.txt"), C2 (a.txt changed, "한글 #1.md" added). */
function historyRepo(): TempRepo {
  const repo = createTempRepo();
  repo.write("a.txt", "one\ntwo\nthree\n");
  repo.write("b b.txt", "bee\n");
  repo.add("a.txt", "b b.txt");
  repo.commit("first GAME-42");
  repo.write("a.txt", "one\n2\nthree\nfour\n");
  repo.write("한글 #1.md", "제목\n");
  repo.add("a.txt", "한글 #1.md");
  repo.commit("second\n\nbody AUTH-03");
  return repo;
}
const brief = (changes: readonly { path: string; staged?: string; unstaged?: string; oldPath?: string }[]) =>
  changes.map((c) => [c.path, c.staged ?? null, c.unstaged ?? null, c.oldPath ?? null]);

describe("repository state", () => {
  it("requires a Git work tree", async () => {
    const r = await openGitProvider(makeTempDir("duo-nogit-"));
    expect(r.diagnostics.map((d) => d.code)).toEqual(["GIT_REPOSITORY_REQUIRED"]);
  });

  it("represents an unborn repository without failing", async () => {
    const repo = createTempRepo();
    repo.write("new.txt", "n\n");
    const git = await provider(repo);
    expect(await value(git.repositoryState())).toEqual({ objectFormat: "sha1", branch: "main", detached: false, unborn: true, shallow: false, rootCommitOids: [] });
    expect(brief(await value(git.listWorkingTreeChanges()))).toEqual([["new.txt", null, "untracked", null]]);
    expect(await value(git.listCommits())).toEqual([]);
    repo.add("new.txt");
    expect(brief(await value(git.listWorkingTreeChanges()))).toEqual([["new.txt", "added", null, null]]);
    const staged = await value(git.getDiff({ from: "HEAD", to: "INDEX", files: [{ path: p("new.txt") }] }));
    expect(staged.map((d) => [d.path, d.kind, d.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])])).toEqual([["new.txt", "added", [[0, 0, 1, 1]]]]);
    expect((await value(git.getDiff({ from: "HEAD", to: "WORKTREE", files: [{ path: p("new.txt") }] }))).map((d) => d.kind)).toEqual(["added"]);
    expect(await value(git.blobProvenance())).toEqual([{ path: "new.txt", indexBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
  });

  it("reports HEAD, branch, identity and detached HEAD", async () => {
    const repo = historyRepo();
    const git = await provider(repo);
    expect(await value(git.repositoryState())).toEqual({ objectFormat: "sha1", headOid: C2, branch: "main", detached: false, unborn: false, shallow: false, rootCommitOids: [C1] });
    repo.git("checkout", "-q", "--detach", C1);
    expect(await value(git.repositoryState())).toEqual({ objectFormat: "sha1", headOid: C1, detached: true, unborn: false, shallow: false, rootCommitOids: [C1] });
  });
});

describe("working tree changes (staged and unstaged axes)", () => {
  it("is empty when clean", async () => {
    expect(await value((await provider(historyRepo())).listWorkingTreeChanges())).toEqual([]);
  });

  it("keeps staged, unstaged, both, untracked, deleted and renamed apart", async () => {
    const repo = historyRepo();
    repo.write("a.txt", "one\n2\nthree\nfour\nfive\n");
    repo.add("a.txt");
    repo.write("a.txt", "one\n2\nthree\nfour\nfive\nsix\n");
    repo.git("mv", "b b.txt", "c #d.txt");
    fs.rmSync(path.join(repo.root, "한글 #1.md"));
    repo.write("staged-only.txt", "s\n");
    repo.add("staged-only.txt");
    repo.write("untracked 😀.txt", "u\n");
    const changes = await value((await provider(repo)).listWorkingTreeChanges());
    expect(brief(changes)).toEqual([
      ["a.txt", "modified", "modified", null],
      ["c #d.txt", "renamed", null, "b b.txt"],
      ["staged-only.txt", "added", null, null],
      ["untracked 😀.txt", null, "untracked", null],
      ["한글 #1.md", null, "deleted", null],
    ]);
    const rename = changes.find((c) => c.path === "c #d.txt");
    expect(rename).toMatchObject({ similarity: 100, headOid: BB, indexOid: BB });
    expect(changes.find((c) => c.path === "a.txt")).toMatchObject({ headOid: A_V2 });
  });

  it("reports a staged type change (regular file → symlink entry) on every OS", async () => {
    const repo = historyRepo();
    repo.addSymlinkEntry("a.txt", "b b.txt");
    const change = (await value((await provider(repo)).listWorkingTreeChanges())).find((c) => c.path === "a.txt");
    expect(change).toMatchObject({ staged: "type-changed", headMode: "100644", indexMode: "120000" });
  });

  it("records a submodule entry without entering it", async () => {
    const repo = historyRepo();
    repo.git("update-index", "--add", "--cacheinfo", `160000,${C1},vendor/lib`);
    const git = await provider(repo);
    expect((await value(git.listWorkingTreeChanges())).find((c) => c.path === "vendor/lib")).toMatchObject({ staged: "added", submodule: true, indexOid: C1 });
    expect((await value(git.blobProvenance())).map((b) => b.path)).not.toContain("vendor/lib");
  });

  it.runIf(process.platform !== "win32")("handles tab and newline in file names", async () => {
    const repo = historyRepo();
    repo.write("tab\tname.txt", "t\n");
    repo.write("new\nline.txt", "n\n");
    repo.add("tab\tname.txt");
    const changes = await value((await provider(repo)).listWorkingTreeChanges());
    expect(brief(changes)).toEqual([["new\nline.txt", null, "untracked", null], ["tab\tname.txt", "added", null, null]]);
  });
});

describe("range changes and diffs", () => {
  it("lists base..HEAD changes and exact hunk ranges", async () => {
    const git = await provider(historyRepo());
    const changes = await value(git.listChanges({ commit: C1 }, "HEAD"));
    expect(changes.map((c) => [c.path, c.kind, c.newOid ?? null])).toEqual([["a.txt", "modified", A_V2], ["한글 #1.md", "added", expect.any(String)]]);
    const [diff] = await value(git.getDiff({ from: { commit: C1 }, to: "HEAD", files: [{ path: p("a.txt") }] }));
    expect(diff?.hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, section: "", lines: [" one", "-two", "+2", " three", "+four"] }]);
    expect((await value(git.getDiff({ from: { commit: C1 }, to: "HEAD", files: [{ path: p("한글 #1.md") }] })))[0]?.hunks[0]?.lines).toEqual(["+제목"]);
  });

  it("diffs staged, unstaged and HEAD→working tree separately", async () => {
    const repo = historyRepo();
    repo.write("a.txt", "one\n2\nthree\nfour\nfive\n");
    repo.add("a.txt");
    repo.write("a.txt", "zero\none\n2\nthree\nfour\nfive\n");
    const git = await provider(repo);
    const ranges = async (from: "HEAD" | "INDEX", to: "INDEX" | "WORKTREE") =>
      (await value(git.getDiff({ from, to, files: [{ path: p("a.txt") }], contextLines: 0 })))[0]?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.lines]);
    expect(await ranges("HEAD", "INDEX")).toEqual([[4, 0, 5, 1, ["+five"]]]);
    expect(await ranges("INDEX", "WORKTREE")).toEqual([[0, 0, 1, 1, ["+zero"]]]);
    expect(await ranges("HEAD", "WORKTREE")).toEqual([[0, 0, 1, 1, ["+zero"]], [4, 0, 6, 1, ["+five"]]]);
  });

  it("shows a rename when both paths are requested", async () => {
    const repo = historyRepo();
    repo.git("mv", "b b.txt", "c #d.txt");
    const [d] = await value((await provider(repo)).getDiff({ from: "HEAD", to: "INDEX", files: [{ path: p("c #d.txt"), oldPath: p("b b.txt") }] }));
    expect(d).toMatchObject({ path: "c #d.txt", oldPath: "b b.txt", kind: "renamed", similarity: 100, hunks: [] });
  });

  it("reports binary files as metadata only", async () => {
    const repo = historyRepo();
    repo.write("img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    repo.add("img.bin");
    repo.commit("binary");
    repo.write("img.bin", Buffer.from([0, 9, 9, 0]));
    const git = await provider(repo);
    const [d] = await value(git.getDiff({ from: "HEAD", to: "WORKTREE", files: [{ path: p("img.bin") }] }));
    expect(d).toMatchObject({ path: "img.bin", kind: "modified", binary: true, hunks: [], oldSize: 6, newSize: 4 });
    expect(d?.oldOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a committed type change", async () => {
    const repo = historyRepo();
    repo.addSymlinkEntry("a.txt", "b b.txt");
    const c3 = repo.commit("a.txt becomes a symlink");
    const changes = await value((await provider(repo)).listChanges({ commit: C2 }, { commit: c3 }));
    expect(changes.map((c) => [c.path, c.kind, c.oldMode, c.newMode])).toEqual([["a.txt", "type-changed", "100644", "120000"]]);
  });

  it("refuses whole-repository diffs, option-like revisions and unknown commits", async () => {
    const git = await provider(historyRepo());
    expect((await git.getDiff({ from: "HEAD", to: "INDEX", files: [] })).diagnostics.map((d) => d.code)).toEqual(["GIT_REQUEST_INVALID"]);
    expect((await git.listChanges({ commit: "--output=x" }, "HEAD")).diagnostics.map((d) => d.code)).toEqual(["GIT_REQUEST_INVALID"]);
    expect((await git.listChanges({ commit: "no-such-branch" }, "HEAD")).diagnostics.map((d) => d.code)).toEqual(["GIT_REVISION_NOT_FOUND"]);
    expect((await git.listChanges("WORKTREE", "HEAD")).diagnostics.map((d) => d.code)).toEqual(["GIT_REQUEST_INVALID"]);
  });
});

describe("provenance", () => {
  it("keeps HEAD and index blob OIDs apart and reads both", async () => {
    const repo = historyRepo();
    repo.write("a.txt", "staged\n");
    repo.add("a.txt");
    repo.write("a.txt", "working tree\n");
    const git = await provider(repo);
    const [a] = await value(git.blobProvenance([p("a.txt")]));
    expect(a?.headBlobOid).toBe(A_V2);
    expect(a?.indexBlobOid).not.toBe(A_V2);
    expect(Buffer.from(await value(git.readBlob("HEAD", p("a.txt")))).toString()).toBe("one\n2\nthree\nfour\n");
    expect(Buffer.from(await value(git.readBlob("INDEX", p("a.txt")))).toString()).toBe("staged\n");
    expect(Buffer.from(await value(git.readBlob({ commit: C1 }, p("a.txt")))).toString()).toBe("one\ntwo\nthree\n");
    expect((await git.readBlob("HEAD", p("missing.txt"))).diagnostics.map((d) => d.code)).toEqual(["GIT_OBJECT_NOT_FOUND"]);
  });

  it("does not modify the repository", async () => {
    const repo = historyRepo();
    repo.write("a.txt", "dirty\n");
    const indexFile = path.join(repo.root, ".git", "index");
    const before = fs.readFileSync(indexFile);
    const git = await provider(repo);
    await git.repositoryState();
    await git.listWorkingTreeChanges();
    await git.getDiff({ from: "INDEX", to: "WORKTREE", files: [{ path: p("a.txt") }] });
    await git.blobProvenance();
    expect(fs.readFileSync(indexFile).equals(before)).toBe(true);
    expect(repo.git("status", "--porcelain")).toBe(" M a.txt\n");
  });
});

describe("history (AC-006-03, AC-006-04)", () => {
  it("lists commits newest first with files and issue key candidates", async () => {
    const commits = await value((await provider(historyRepo())).listCommits());
    expect(commits.map((c) => [c.oid, c.parents, c.files])).toEqual([[C2, [C1], ["a.txt", "한글 #1.md"]], [C1, [], ["a.txt", "b b.txt"]]]);
    expect(commits.flatMap((c) => extractIssueKeys(c.message))).toEqual(["AUTH-03", "GAME-42"]);
  });

  it("computes CHANGED_WITH candidates by the 04 rule", () => {
    const commit = (oid: string, files: string[]) => ({ oid, parents: [], message: "", files: files.map(p) });
    const wide = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
    const candidates = computeCoChangeCandidates([
      commit("1", ["b.ts", "a.ts"]), commit("2", ["a.ts", "b.ts", "c.ts"]), commit("3", ["a.ts", "b.ts"]),
      commit("4", ["a.ts", "c.ts"]), commit("5", ["a.ts", "c.ts", ...wide]),
    ]);
    expect(candidates).toEqual([{ a: "a.ts", b: "b.ts", count: 3 }]);
  });

  it("extracts issue keys from messages and branch names", () => {
    expect(extractIssueKeys("feature/GAME-42-login")).toEqual(["GAME-42"]);
    expect(extractIssueKeys("Fix AUTH-03 and AUTH-03, see TASK-012A; not game-1 or XAUTH-3x")).toEqual(["AUTH-03", "TASK-012A"]);
  });
});
