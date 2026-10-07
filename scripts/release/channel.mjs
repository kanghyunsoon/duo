/**
 * Release channel policy (H-70 dual-track, T43.1). The version alone decides where a release candidate is cut and
 * where it is published; there is no override flag or waiver.
 *
 *   stable      (no SemVer prerelease component, e.g. 0.2.2, 0.3.0):  branch main, upstream origin/main,
 *               npm dist-tag latest, GitHub Release prerelease false
 *   prerelease  (a SemVer prerelease component, e.g. 0.3.0-rc.3):     branch next, upstream origin/next,
 *               npm dist-tag next, GitHub Release prerelease true
 *
 * Any other branch blocks. Pure functions: release:preflight and release:verify-published call them, tests check them.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** "stable", "prerelease", or null when the version is not SemVer. */
export function releaseChannel(version) {
  const m = SEMVER.exec(String(version));
  if (m === null) return null;
  return m[4] === undefined ? "stable" : "prerelease";
}

/** What the version's channel expects, or null when the version is not SemVer. */
export function channelPolicy(version) {
  const channel = releaseChannel(version);
  if (channel === null) return null;
  return channel === "stable"
    ? { releaseChannel: "stable", expectedBranch: "main", expectedUpstream: "origin/main", expectedDistTag: "latest", githubPrerelease: false }
    : { releaseChannel: "prerelease", expectedBranch: "next", expectedUpstream: "origin/next", expectedDistTag: "next", githubPrerelease: true };
}

/** The npm publish arguments for a tarball of this version (the dist-tag comes from the channel). */
export function publishArgs(tarball, version, { dryRun = false } = {}) {
  const policy = channelPolicy(version);
  if (policy === null) throw new Error("not a SemVer version: " + version);
  return ["publish", tarball, ...(dryRun ? ["--dry-run", "--json"] : []), "--access", "public", "--tag", policy.expectedDistTag];
}

/**
 * Blockers ({ id, message }) for the git state of a release candidate.
 * upstream is the tracking branch name (git rev-parse --abbrev-ref @{u}, e.g. "origin/next"), upstreamCommit its commit.
 */
export function gitPolicyBlockers({ version, branch, upstream, upstreamCommit, commit }) {
  const policy = channelPolicy(version);
  if (policy === null) return [{ id: "version-invalid", message: "the package version " + JSON.stringify(version) + " is not SemVer" }];
  const out = [];
  if (branch !== policy.expectedBranch) {
    out.push({ id: "git-branch", message: policy.releaseChannel + " " + version + " is cut from " + policy.expectedBranch + " (H-70), current branch: " + branch });
  }
  if (upstream !== policy.expectedUpstream) {
    out.push({ id: "git-upstream", message: "the upstream of " + branch + " is " + (upstream || "(none)") + ", expected " + policy.expectedUpstream });
  } else if (upstreamCommit !== commit) {
    out.push({ id: "git-not-pushed", message: "HEAD is not the pushed " + policy.expectedUpstream + " commit" });
  }
  return out;
}

/**
 * Problems ({ id, message }) for a published version: its dist-tag points to it, a prerelease leaves latest on a
 * stable version, and the GitHub Release (when it exists) has the channel's prerelease flag.
 */
export function publishedChannelProblems({ version, distTags, githubRelease }) {
  const policy = channelPolicy(version);
  if (policy === null) return [{ id: "version-invalid", message: "not a SemVer version: " + version }];
  const tags = distTags ?? {};
  const out = [];
  if (tags[policy.expectedDistTag] !== version) {
    out.push({ id: "dist-tag", message: "npm dist-tag " + policy.expectedDistTag + " is " + (tags[policy.expectedDistTag] ?? "(none)") + ", expected " + version });
  }
  if (policy.releaseChannel === "prerelease" && (tags.latest === version || releaseChannel(tags.latest) !== "stable")) {
    out.push({ id: "dist-tag-latest", message: "npm dist-tag latest is " + (tags.latest ?? "(none)") + "; a prerelease must leave latest on a stable version" });
  }
  if (githubRelease?.exists === true && githubRelease.prerelease !== policy.githubPrerelease) {
    out.push({ id: "github-release-prerelease", message: "the GitHub Release is marked prerelease " + githubRelease.prerelease + ", expected " + policy.githubPrerelease + " for a " + policy.releaseChannel + " version" });
  }
  return out;
}
