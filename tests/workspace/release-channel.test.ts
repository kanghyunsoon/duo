/**
 * Release channel policy (H-70 dual-track, T43.1): the version decides the branch, upstream, npm dist-tag and the
 * GitHub Release prerelease flag. release:preflight and release:verify-published use these functions.
 */
import { describe, expect, it } from "vitest";
import { channelPolicy, gitPolicyBlockers, publishArgs, publishedChannelProblems, releaseChannel } from "../../scripts/release/channel.mjs";

const C = "1".repeat(40);
const ids = (o: { version: string; branch: string; upstream?: string; upstreamCommit?: string }) =>
  gitPolicyBlockers({ upstream: "origin/" + o.branch, upstreamCommit: C, commit: C, ...o }).map((b) => b.id);

describe("release channel policy (H-70)", () => {
  it("classifies versions by the SemVer prerelease component", () => {
    expect(releaseChannel("0.2.2")).toBe("stable");
    expect(releaseChannel("0.3.0")).toBe("stable");
    expect(releaseChannel("0.3.0-rc.3")).toBe("prerelease");
    expect(releaseChannel("0.3.0+build.1")).toBe("stable");
    expect(releaseChannel("0.3")).toBeNull();
    expect(channelPolicy("0.3.0-rc.3")).toEqual({ releaseChannel: "prerelease", expectedBranch: "next", expectedUpstream: "origin/next", expectedDistTag: "next", githubPrerelease: true });
    expect(channelPolicy("0.2.2")).toEqual({ releaseChannel: "stable", expectedBranch: "main", expectedUpstream: "origin/main", expectedDistTag: "latest", githubPrerelease: false });
  });

  it("A, B, C: stable on main and a prerelease on next pass", () => {
    expect(ids({ version: "0.2.2", branch: "main" })).toEqual([]);
    expect(ids({ version: "0.3.0", branch: "main" })).toEqual([]);
    expect(ids({ version: "0.3.0-rc.3", branch: "next" })).toEqual([]);
  });

  it("D, E: a prerelease on main and a stable version on next block git-branch; other branches block too", () => {
    expect(ids({ version: "0.3.0-rc.3", branch: "main", upstream: "origin/next" })).toEqual(["git-branch"]);
    expect(ids({ version: "0.3.0", branch: "next", upstream: "origin/main" })).toEqual(["git-branch"]);
    expect(ids({ version: "0.3.0-rc.3", branch: "feature/foo", upstream: "origin/next" })).toEqual(["git-branch"]);
    expect(ids({ version: "0.3.0-rc.3", branch: "main" })).toEqual(["git-branch", "git-upstream"]);
  });

  it("the upstream must be the channel's and pushed to HEAD", () => {
    expect(ids({ version: "0.3.0-rc.3", branch: "next", upstream: "" })).toEqual(["git-upstream"]);
    expect(ids({ version: "0.3.0-rc.3", branch: "next", upstreamCommit: "2".repeat(40) })).toEqual(["git-not-pushed"]);
    expect(ids({ version: "0.3", branch: "main" })).toEqual(["version-invalid"]);
  });

  it("F, G: the publish dist-tag (also for the dry run) is next for a prerelease and latest for a stable version", () => {
    expect(publishArgs("x.tgz", "0.3.0-rc.3", { dryRun: true })).toEqual(["publish", "x.tgz", "--dry-run", "--json", "--access", "public", "--tag", "next"]);
    expect(publishArgs("x.tgz", "0.2.2", { dryRun: true })).toEqual(["publish", "x.tgz", "--dry-run", "--json", "--access", "public", "--tag", "latest"]);
    expect(publishArgs("x.tgz", "0.3.0-rc.3")).toEqual(["publish", "x.tgz", "--access", "public", "--tag", "next"]);
  });

  it("published prerelease: next points to it, latest stays on a stable version, the GitHub Release is a prerelease", () => {
    const ok = { version: "0.3.0-rc.3", distTags: { latest: "0.2.2", next: "0.3.0-rc.3" }, githubRelease: { exists: true, prerelease: true } };
    expect(publishedChannelProblems(ok)).toEqual([]);
    expect(publishedChannelProblems({ ...ok, distTags: { latest: "0.3.0-rc.3", next: "0.3.0-rc.3" } }).map((p) => p.id)).toEqual(["dist-tag-latest"]);
    expect(publishedChannelProblems({ ...ok, distTags: { latest: "0.2.2", next: "0.3.0-rc.2" } }).map((p) => p.id)).toEqual(["dist-tag"]);
    expect(publishedChannelProblems({ ...ok, githubRelease: { exists: true, prerelease: false } }).map((p) => p.id)).toEqual(["github-release-prerelease"]);
  });

  it("published stable: latest points to it and the GitHub Release is not a prerelease", () => {
    const ok = { version: "0.2.2", distTags: { latest: "0.2.2" }, githubRelease: { exists: true, prerelease: false } };
    expect(publishedChannelProblems(ok)).toEqual([]);
    expect(publishedChannelProblems({ ...ok, distTags: { latest: "0.2.1" } }).map((p) => p.id)).toEqual(["dist-tag"]);
    expect(publishedChannelProblems({ ...ok, githubRelease: { exists: true, prerelease: true } }).map((p) => p.id)).toEqual(["github-release-prerelease"]);
  });
});
