# Issue 40-1 through 40-3: launcher verification

Status: D1 and D2 settled by the maintainer on PR #75. 40-2 and 40-3 implementation is in this draft; keep it in draft until implementation and validation are complete. Release authorization is separate.
Date: 2026-10-23. Source baseline: `next` `6c6c872`.
Issue: [#40](https://github.com/kanghyunsoon/duo/issues/40).
Brief: [T91](https://github.com/kanghyunsoon/duo/issues/40#issuecomment-6284137321).
Review: [BE-1 feedback](https://github.com/kanghyunsoon/duo/pull/75#issuecomment-6355715433).
Policy: [maintainer D1/D2 decisions](https://github.com/kanghyunsoon/duo/pull/75#issuecomment-6356707094).

40-1 recorded a resolution-only reproduction and design. 40-2 now applies the measured-runner PATH policy consistently to planning, lookup and probing. 40-3 adds the agreed version warning. The compatibility section records changed success/exit outcomes; generated configurations stay portable.

## Reproduction

Run from the workspace:

```sh
pnpm exec vitest run packages/integration/src/agents/launcher-path.repro.test.ts
pnpm exec vitest run packages/integration/src/agents/agents.test.ts
```

The deterministic fixture creates a newer-looking project-local launcher and an older-looking global launcher. It passes two explicit host environments to the existing `checkLauncher`, without changing the user's PATH:

| Environment | PATH order | Current resolution |
|---|---|---|
| Installer under npm exec | project `node_modules/.bin`, global bin | project-local launcher |
| Agent outside npm exec | global bin | global launcher |

Both Codex and Claude Code adapters keep `command: "duoctl"`; generating the configuration does not pin the executable checked during install. Fixture versions label the files only: this test does not start a server, run npm exec, or claim a measured version handshake.

The current verification path confirms the second cause by inspection: `verifyAgentIntegration` uses the supplied host for `checkLauncher` and forwards the same PATH to `probeMcpLaunch`. It records `probe.serverVersion`, but its `ok` only checks configuration, bridge, launcher availability, server name and tools. No running CLI version is passed in or compared. Doctor displays the returned version but also accepts `verify.ok` without comparison.

## Settled behavior (D1 and D2)

| Situation | Install verification | Doctor |
|---|---|---|
| Launcher and running CLI versions match | Existing checks determine success; no mismatch warning | Existing checks apply |
| Known, non-empty versions differ | Add `launcher-version-mismatch`, CLI/server versions, resolved path and both safe next steps; warning alone preserves the existing result/exit code | 40-4: a passing agent check becomes warning `version-mismatch` with the same facts and action `align-launcher`; failed checks stay errors; exit stays 0 |
| Probe skipped/failed, or either version missing or `""` | No mismatch claim; existing failures stay failures | Existing failure/offline behavior |
| Effective agent PATH contains no `duoctl` | Fail, never report `Verify: ok`; recommend reinstalling with `--launcher npx` | Existing unavailable-launcher error through shared verification |

### D1: no launcher on the agent PATH (settled: fail)

DUO installed only as a devDependency followed by `npx duoctl install codex` with the default `path` launcher previously verified through an injected project-local binary, although an agent outside that runner had no `duoctl`.

The effective PATH now makes `checkLauncher` return `available: false`. The existing pre-apply plan blocks installation with `EXIT.ACTION_REQUIRED` (6), writes no integration configuration and includes the `--launcher npx` recommendation. Direct verification of an existing configuration returns `verify.ok: false`, does not probe an unavailable executable, and adds `duoctl install <agent> --launcher npx` to next actions. A failure reached after apply still uses the existing `EXIT.ERROR` (1) verification branch. The alternative of preserving `ok` for an unavailable launcher was not adopted.

### D2: version-mismatch warning (settled)

The CLI passes its package version through `VerifyOptions.cliVersion`. The MCP initialize response supplies the actual server version; no additional `--version` subprocess or upward package dependency is added. Missing caller versions and the probe's empty-string version mean unknown. Only exact, non-empty strings are compared, without semver-range interpretation or normalization.

`AgentIntegrationVerification.warnings` is an optional additive array; each mismatch entry contains `code: "launcher-version-mismatch"`, `cliVersion`, `serverVersion`, `resolved` and two `nextActions`. Human install output renders the facts and safe actions in en/ko. Safe actions are to update the global DUO installation to the running CLI version, or reinstall with `duoctl install <agent> --launcher npx` for a project dependency. Neither action executes automatically.

Warnings never override `checks.every(...)`: unavailable launchers, wrong server names, incompatible tool lists and failed MCP launches remain failures. Doctor-specific mismatch facts/output remain 40-4 work; its existing internal call without `cliVersion` makes no mismatch claim.

## Recorded runner evidence and selected PATH rule

The actual Windows measurements are in [issue-40-runner-evidence.json](issue-40-runner-evidence.json). They were recorded **before** selecting the predicate, with Node 24.18.0, npm 12.0.1, pnpm 11.25.0 and Yarn Classic 1.22.22. Each runner ran in an independent fresh PowerShell process to avoid cross-command environment effects. `null` means unset. The raw record includes all three marker values and the ordered PATH prefix; personal/fixture path components are replaced with placeholders. The inherited PATH suffix was verified identical and omitted.

| Actual runner | `npm_command` | `npm_execpath` (suffix; full normalized value in record) | `npm_lifecycle_event` | Coverage |
|---|---|---|---|---|
| `npx --no-install duo-runner-env-probe` | `exec` | `npm/bin/npm-cli.js` | `npx` | Covered |
| `npm exec --offline -- duo-runner-env-probe` | `exec` | `npm/bin/npm-cli.js` | `npx` | Covered |
| `npm run probe --silent` | `run` | `npm/bin/npm-cli.js` | `probe` | Covered |
| `pnpm exec duo-runner-env-probe` | `exec` | unset | unset | Covered; injected relative `./node_modules/.bin` is also removed |
| `pnpm --package <local-tarball> dlx duo-runner-env-probe` | unset | unset | unset | **Gap:** cannot identify from these markers; retains current behavior |
| Yarn 1 `yarn --silent run probe` | unset | `yarn/bin/yarn.js` | `probe` | **Partial:** project and `Yarn\Data\link\node_modules\.bin` are removed; the prepended `Yarn\bin` (where `yarn global add` installs binaries) and the temporary `yarn--<id>` shim directory are kept, so a `duoctl` there still verifies whether or not the agent PATH contains it |
| npm lifecycle shortcuts (`npm test`, `npm start`, …) | `test`, `start`, … (not measured) | — | — | **Gap (not measured):** not matched; retains current behavior |
| npm versions reporting `run-script` | `run-script` (not measured) | — | — | **Gap (not measured):** not matched; retains current behavior |
| `pnpm run <script>` | not measured | — | — | **Gap (not measured):** coverage unknown; not claimed |

Selected activation for a `path` launcher: `npm_command` is `exec` or `run`, or a non-empty `npm_lifecycle_event` accompanies an `npm_execpath` ending in `yarn.js`. This is deliberately limited to the measured signatures. The unmeasured forms above, Yarn Berry/PnP, other runner versions and actual POSIX runner invocations are not validated coverage; where the predicate does not fire, the original #40 behavior remains. The marker-free pnpm dlx case remains unfixed; it is not inferred to be supported.

Planning and verification share `effectiveLauncherHost`; executable lookup and the MCP probe use that same effective environment. It removes normalized terminal `node_modules/.bin` directory entries, including project, ancestor and cache bins, while keeping the other entries in order. Windows case/separators/PATH-key casing and PATHEXT are preserved; POSIX path matching is case-sensitive. Explicit `npx` and custom/absolute launchers retain the original PATH. The supplied host and real process environment are never mutated, and no machine path is written into generated config.

This approximates an agent outside the runner. A runner cannot identify which identical PATH entries were already present, and GUI agents may inherit a different PATH. Non-bin helper directories added by runners are left intact.

### Reproducing the measurements

Create a tiny package `duo-runner-env-probe@1.0.0`, with bin `duo-runner-env-probe` pointing to executable `probe.cjs`:

```js
#!/usr/bin/env node
const path = require("node:path");
const env = process.env;
const key = Object.keys(env).find(k => k.toUpperCase() === "PATH");
console.log(JSON.stringify({node: process.version, npm_command: env.npm_command ?? null,
  npm_execpath: env.npm_execpath ?? null, npm_lifecycle_event: env.npm_lifecycle_event ?? null,
  PATH: (env[key] ?? "").split(path.delimiter)}, null, 2));
```

Pack it with `npm pack --ignore-scripts` and install the local tarball as a devDependency of an isolated project, with script `"probe": "duo-runner-env-probe"`. Run the six commands in the table from that project, separately. The dlx command points at the same local tarball. Yarn 1.22.22 was installed only into an isolated tools prefix and invoked through its `bin/yarn.js`; no global package/provider configuration was changed. The probe only prints environment data; it does not run DUO, an LLM or a paid experiment.

## Compatibility boundary

40-1 alone changed no production behavior. The 40-2 PATH correction can change verification success and exit codes:

- The previously hidden no-launcher case now fails under D1: pre-apply planning blocks with exit 6; a reached verification failure returns exit 1. No unavailable launcher is reported as verified.
- An actual older global binary can start but expose a different tool list. The existing `mcp-launch` check compares its tools with this build's `EXPECTED_MCP_TOOLS` (and checks the server name), so verification can now fail where probing the injected local binary currently passes. Keep that validation intact and report the real result; the install verification branch then returns `EXIT.ERROR`.
- When the predicate fires, the filter removes **every** terminal `node_modules/.bin` entry, including one the user put on PATH before running the installer (for example a project bin added by direnv). Runner additions are a contiguous prefix in the evidence, but Yarn's prefix also contains non-bin directories, so prefix-only filtering is not attempted. Such a user can now get the D1 failure even though an agent started from the same shell would find `duoctl`. Remedy: reinstall with `--launcher npx`, or install `duoctl` globally. A unit test pins this behavior.

The unchanged-success/exit-code claim applies only to adding the 40-3 version-mismatch warning itself, as confirmed in D2. It is not a promise for 40-2 or the whole issue. A matching or unknown version does not override a failed launcher, server-name or tool-list check.

## Change reach

| Surface | Planned work |
|---|---|
| `packages/integration/src/agents/launcher.ts` | Pure effective-host policy, shared by planning and verification |
| `packages/integration/src/agents/integration.ts` | Use the same effective host for lookup/probe; compare supplied runtime version; additive warning |
| `packages/integration/src/agents/types.ts` | Optional additive version-warning facts; missing launchers fail under D1 |
| `packages/integration/src/operations/doctor.ts` | 40-4 follow-up: forward the runtime version supplied by the CLI; add mismatch facts and remediation without downgrading failed checks |
| `apps/cli/src/commands/install.ts`, `doctor.ts`, `messages.ts` | Pass version; render versions, resolved path and safe actions in en/ko |
| Agent unit, CLI install and doctor tests | Fake PATH/version cases for both adapters; Windows and POSIX CI |
| CLI/MCP documentation | Explain the diagnostic, safe remediation and GUI PATH limitation |

No schema migration, new MCP tool, MCP tool schema change, Decision authority change, trust/approval automation, one-command setup or discovery timing change belongs in this issue. Preserve installation/removal backups and safety checks, `launch: false`, and offline behavior.

## Work split and acceptance evidence

1. **40-1 (1 SP):** this note and deterministic resolution reproduction; BE-1 review before production implementation.
2. **40-2 (2 SP):** implemented: recorded six real runner environments, stated coverage/gaps, shared effective-host policy and targeted no-launcher/lookup/probe tests.
3. **40-3 (2 SP):** implemented: additive version-mismatch warning and en/ko CLI rendering; tests cover exact strings, missing/empty versions and existing failures. The warning itself does not change the result/exit code of the existing checks.
4. **40-4 (2 SP):** implemented: doctor passes its runtime version to the shared verification and reports `version-mismatch` (warning, en/ko, action `align-launcher`). The remediation wording now names the resolved installation for every launcher kind instead of "the global DUO installation".
5. **40-5 (3 SP):** implemented: real-subprocess doctor cases for Codex and Claude Code (older server warns with exit 0; a tool-list failure stays an exit 6 error despite the version difference; a matching version is verified) and removal with no launcher on the effective PATH. Explicit npx, `launch: false` (offline), failed probes and missing/empty versions were already pinned by the agent unit tests and the 40-3 install subprocess tests; they are not duplicated.

A resolution-only test is not proof that the configured process reports the expected version. The subprocess and CLI checks above remain required before closing #40. Draft PRs target `next`; D1 and D2 are confirmed; the PR stays in draft until implementation and validation are complete. Publishing 0.3.4 is a separate maintainer decision.

## Client and model boundary

#40 tests executable resolution, process environment and the MCP handshake; it does not require an LLM or require writing the fix in Claude Code. Both adapters need coverage.

[#31](https://github.com/kanghyunsoon/duo/issues/31) separately asks whether the real Claude Code client starts DUO, exposes tools and calls them during a task. A gateway-backed setup must record client version, gateway version, actual upstream model, tool-search settings and launch environment. A non-Claude model cannot establish Claude-model behavior or an ordinary supported Claude Code baseline. Do not change global client/provider settings or run paid/account-consuming tasks as part of 40-1.

## Historical 40-1 validation record

Windows, Node 24.18.0, pnpm 11.25.0; source baseline `6c6c872`.

- Existing Agent unit tests: 18 passed before adding the reproduction.
- Combined existing and reproduction tests: 2 files, 20 passed (2 new resolution cases).
- Workspace typecheck, targeted ESLint and package boundary checks: passed.
- Documentation validation after the BE-1 documentation revision: passed (120 Markdown files); code-test results were not rerun for that earlier documentation-only commit.
- At the 40-1 stage, real runner invocations and versioned MCP subprocesses were not tested. Current evidence and validation are recorded separately above/below. Real client and POSIX runner execution remain untested.
- No model/API experiment, global PATH change or provider change. 40-2/40-3 production implementation and its current validation are recorded below.

## 40-2/40-3 validation

- Before the fix: 4 regression failures across both adapters reproduced local/global resolution and missing-launcher false success; 2 explicit npx controls passed.
- After the final Windows PATH-key fix: 50 agent tests passed, including runner-evidence signatures, PATH boundary handling, unknown/exact versions, failure preservation and existing adapter/removal tests.
- Built CLI subprocess tests: 8 passed for Codex/Claude Code configurations, JSON and en/ko warning output, missing launchers, matching/empty versions and incompatible tool lists. Final workspace check results are recorded in PR #75. New real-probe CLI cases join the existing `agent-launch` test group (C254) rather than the parallel startup storm; the product probe timeout is unchanged.
- Actual Codex/Claude Code clients, POSIX runner measurements and paid AI experiments remain not tested; 40-4/40-5 and release authorization remain separate.

- Final affected suite: `pnpm test packages/integration/src/agents/ tests/install/ tests/cli/doctor.e2e.test.ts` passed **6 files / 86 tests**, including the existing install/doctor regressions, under the same pnpm script context as CI. Windows host marker lookup is case-insensitive; the CLI fixture removes case-insensitive duplicate `npm_command` keys before setting its intended marker, so Vitest's uppercase inherited `NPM_COMMAND` cannot override it in native spawn.
- A full local `pnpm verify` at `1c54625` passed 1,323 tests and failed 8 (7 skipped): 6 new CLI cases exposed that fixture-key collision and now pass in the final affected suite; 2 existing UI browser cases timed out (`Live graph probe` visibility and `Deterministic review:` visibility). The UI cases remain unaddressed. No UI assertions/timeouts were changed, and a clean full local verify is not claimed; final three-OS CI remains the validation gate.
