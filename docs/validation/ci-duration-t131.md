# CI duration baseline and duplicate validation (T131)

This report measures the `ci` workflow on `next` and pull requests, and records why the change in this PR is limited to removing work the same job repeats. All figures come from GitHub Actions job and step timestamps. No paid service and no AI API was used.

## Baseline

Sample: the 59 most recent completed `ci` runs between 2026-10-20 23:56Z and 2026-10-24 06:14Z: 50 succeeded, 8 were cancelled by `concurrency: cancel-in-progress` (a newer push to the same ref), and 1 failed (`39902213113`, a Windows `pnpm test` failure on a PR branch under development). Statistics below use the 50 successful runs.

| Measure | Median | P90 | Max |
|---|---:|---:|---:|
| Wall time, first job start to last job end | 36.0 min | 39.9 min | 66.4 min |
| Sum of the three job durations (runner minutes) | 57.4 min | 63.5 min | 67.9 min |
| `verify (windows-latest, node 24)` | 36.0 min | 39.8 min | 46.1 min |
| `verify (ubuntu-latest, node 24)` | 11.0 min | 12.6 min | 19.5 min |
| `verify (macos-latest, node 24)` | 10.8 min | 14.2 min | 15.2 min |

Push runs on `next` (n = 13) had a median wall time of 34.9 min, and pull-request runs (n = 37) had 36.3 min. The Windows job alone sets the wall time.

Slowest steps (median, P90, max in minutes, 50 runs):

| Step | Windows | macOS | Ubuntu |
|---|---|---|---|
| distribution E2E (`pnpm test:dist`) | 12.5 / 15.9 / 18.5 | 1.8 / 2.5 / 2.6 | 1.8 / 1.9 / 2.0 |
| `pnpm test` | 11.9 / 12.7 / 13.2 | 5.1 / 7.0 / 7.8 | 4.5 / 5.3 / 5.5 |
| release conformance (`pnpm test:conformance`) | 8.7 / 9.9 / 13.4 | 2.5 / 3.3 / 3.7 | 2.7 / 3.1 / 3.1 |
| benchmark smoke | 0.5 | 0.2 | 0.2 |
| everything else (setup, lint, typecheck, build, Chromium, grammars, docs) | under 2 in total | | |

On Windows these three steps take about 33 of the 36 minutes.

## Where the time goes (run 40069420345, `afb3b05`, Windows)

| Step | Part | Time |
|---|---|---:|
| distribution E2E | `pack-cli` (esbuild bundle, isolated `npm ci` of the runtime tree, `npm pack`) | 1 min 50 s |
| | "packing again gives the same files" (second pack into a temporary directory) | 111 s |
| | project-local `npm install` + `npx --no-install duoctl` | about 3 min |
| | global install, journeys, failure messages | remainder of 9 min |
| release conformance | `pnpm build` + `pack-cli` again | 1 min 44 s |
| | isolated global `npm install` of the tarball | 3 min 1 s |
| | C209 (6 installed `duoctl init` runs) | 15 s |
| | conformance suite against the installed CLI (118 tests, 13 files) | 4 min 4 s |
| `pnpm test` | 145 files, 1,390 tests, 780 s wall | |

## Test inventory by category (`pnpm test`, same run)

File time is the sum of per-file durations reported by Vitest; files run in parallel, so it is larger than wall time.

| Category | Files | Tests | Windows s | Ubuntu s | macOS s |
|---|---:|---:|---:|---:|---:|
| Unit | 68 | 698 | 56 | 12 | 17 |
| Integration, in-process E2E (`packages/**/*.e2e.test.ts`) | 37 | 341 | 721 | 106 | 187 |
| Integration, workspace and docs (`tests/workspace`, `tests/docs`, …) | 6 | 52 | 17 | 5 | 6 |
| HTTP security and UI API | 3 | 55 | 27 | 4 | 10 |
| CLI and MCP subprocess E2E (`tests/cli`, `tests/mcp`) | 19 | 120 | 1,008 | 311 | 341 |
| OS-dependent agents and process control | 3 | 51 | 1 | 0 | 0 |
| UI browser E2E (`tests/ui`) | 5 | 25 | 82 | 25 | 39 |
| Install, remove and launcher (`tests/install`) | 2 | 28 | 118 | 38 | 48 |
| Release conformance RC checks (`tests/conformance`) | 1 | 15 | 165 | 56 | 75 |
| Benchmark and validation tooling | 1 | 5 | 0 | 0 | 0 |

Outside `pnpm test`: `tests/distribution/dist.e2e.test.ts` (22 tests, packed artifact) and the release conformance suite.

## The duplicate

`vitest.conformance.config.ts` runs 13 files (`tests/cli` existing-project, first-run, languages, semantic, ui, doctor, compatible; `tests/mcp/**`; `tests/install/**`; `tests/conformance/**`) against the installed tarball. `pnpm test` runs the same 13 files against the workspace build. The only difference is `CLI_MAIN` in `tests/cli/support.ts`: `DUO_CONFORMANCE_CLI` (the installed `dist/duoctl.js`) or `apps/cli/dist/main.js`. No test branches on which one it gets. So every CI job runs these 118 tests twice on every OS.

| | Windows | Ubuntu | macOS |
|---|---:|---:|---:|
| File time of the 13 files inside `pnpm test` | 809 s of 2,194 s (37%) | 275 s of 557 s | 332 s of 723 s |

The release conformance step also runs `pnpm build` and `scripts/pack-cli.mjs` again, although the distribution E2E step packed the same commit minutes earlier. The distribution E2E already proves that packing is deterministic.

What the second run would catch that the first does not: a bug that exists only in the `tsc` workspace output (`apps/cli/dist/main.js`) and not in the esbuild bundle that ships. Users run the bundle (`dist/duoctl.js` via the `bin` entry, which imports the same `main`). The workspace entry keeps its own `node apps/cli/dist/main.js --version` smoke step, and every in-process test still runs against the source.

## Change in this PR

1. `vitest.conformance-files.ts` holds the conformance file list. `vitest.conformance.config.ts` and `vitest.config.ts` both read it, so the two cannot drift.
2. With `DUO_TEST_DEFER_CONFORMANCE=1` (CI only), `pnpm test` excludes those files and prints which ones it deferred. The C254 `agent-launch` group then has no files left and is omitted. Without the variable, `pnpm test` is unchanged.
3. The release conformance step runs `scripts/ci/check-packed-artifact.mjs`, which checks that the tarball's sha512 equals `.dist/pack.json` integrity and that the version matches this checkout, and then runs `scripts/release/conformance.mjs`. That script already reuses `.dist/pack.json` when it exists. `pnpm test:conformance` (build + pack + conformance) is unchanged for local and RC use.
4. The job name `verify (<os>, node 24)` and the three required checks of the `next-integration` ruleset are unchanged. There are no path filters, skips, `continue-on-error` or timeout changes.

Local file-set check (`vitest list`): the full run has 145 files, the deferred run 132, and the conformance config 13. The deferred and conformance sets are disjoint, and their union is exactly the full set.

## Not changed, and options left for a decision

- The RC gates (`release:preflight`, `release:audit`, `release:upgrade`, `release:authorization`, `release:verify-published`) and `pnpm test:conformance` are untouched.
- The distribution E2E is unchanged, including the deterministic second pack (111 s on Windows) and the project-local npx install (about 3 min).
- Further savings would reduce what a pull request verifies on Windows, for example running the full distribution E2E only on `next` pushes or RC candidates. Those need a Maintainer decision and a ruleset plan, because required checks must still report on every pull request. They are not part of this PR.
