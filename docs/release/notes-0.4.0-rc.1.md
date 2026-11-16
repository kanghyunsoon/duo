# DUO 0.4.0-rc.1 release notes

Release candidate on the `next` development line, published to the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable release stays 0.3.4 on `latest`. This is a prerelease, not a stable release: 0.4.0 needs a separate decision. External Validation 01 keeps using exactly 0.2.1.

0.4.0-rc.1 contains everything in [0.3.3](notes-0.3.3.md) and the [0.3.4 security patch](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.4.md) plus the changes below.

## What changes for users

### Work map in the local UI (#52, #79, #85, #86)

- `duoctl ui --open` has a new `/work` page. It draws work items next to the Project Graph. A successful `duo_get_context` call records the agent name and the first line of the task as local activity, and `duo_review_changes` with a `task` updates it. People can also add and complete items in the UI. See [work-map.md](../work-map.md).
- The activity lives in `.duo-project/runtime/work-tasks.json` (bounded to 128 KiB) and `.duo-project/cache/work-map.json`. Both are local, regenerable files, not Project Truth, and both directories are in the `.duo-project/.gitignore` that `duoctl init` writes.
- Task names and agent labels go through the same secret redaction as Context Packets before they are stored or shown (#84, #85). A task file written by an earlier `next` build is rewritten with redacted labels the next time the map reads it.
- The map works at a 320px viewport in light and dark themes without page-level horizontal scrolling. The graph pans and zooms inside its own canvas (#70). Work map keyboard selection keeps the detail panel in sync, and nodes are named buttons with a selected state (#71, #72).

### MCP tool annotations (#61)

- `duo_get_context` and `duo_review_changes` now advertise `readOnlyHint: false`, `idempotentHint: false` and `destructiveHint: true` (0.3.4 and earlier: read-only). Each call appends to `runtime/metrics.jsonl`, and with a DUO session it updates the Work map activity file, which can prune old completed or disconnected records when full. Neither tool changes Project Truth, source code or the index.
- Some MCP clients ask for approval before a tool that is not read-only. Whether Codex and Claude Code do so for these two tools has not been measured. Per-tool approval settings are described in [06-mcp-interface.md](../06-mcp-interface.md).
- Tool names, input schemas and results are unchanged. There are still nine tools.

### Agent launcher checks (#40, #75, #81)

- `duoctl install` resolves the `duoctl` launcher on the PATH the agent will use. Under the measured npm/pnpm/Yarn runner signatures, the `node_modules/.bin` entries the runner added are removed first. If the agent would not find `duoctl`, the install plan stops with exit 6 and recommends `--launcher npx`. Nothing is written. Before, it reported `Verify: ok`.
- When the running CLI and the MCP server that the launcher starts report different versions, install verification adds a `launcher-version-mismatch` warning and `duoctl doctor` reports `version-mismatch` with both versions, the resolved path and a next step. A warning alone does not change success or exit codes. Tool-list failures stay errors.

### Local UI API (#53, #54, #76, #78)

- New read-only endpoints for the UI: `GET /api/decisions` (`duo.ui.decisions/1`), `GET /api/decisions/{id}` (`duo.ui.decision-detail/1`) and `GET /api/proposals/{id}/preview` (`duo.ui.preview/1`), plus the Work map routes. They need the same loopback session as the rest of the UI API.
- `/api/decisions/{id}` and `/api/proposals/{id}/preview` reject any query parameter, and `/api/decisions` rejects a repeated parameter name, with 400 `UI_REQUEST_INVALID` (#77).

## Security dependency updates (same as 0.3.4)

The bundled MCP SDK (`@modelcontextprotocol/client`, `server`, `core`) is 2.3.1 and `zod` is 4.6.7, the same versions as the 0.3.4 security patch (#88, #89). This fixes GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq, GHSA-6prh-2h8m-c8cw and GHSA-mrhx-c7xc-m3w5. The MCP SDK license is Apache-2.0 from 2.3.1 on; `dist/THIRD_PARTY_NOTICES.md` carries its text. The release lock has the same 67 packages as 0.3.4.

## Unchanged

- Project Truth (`schema_version: 1`), Decision Lock format and digests, `duo.review/1`, `duo.context/1`, `duo.context-packet/1`, `duo.gap-assessment/1`, `duo.review-record/1`, `duo.adoption-baseline/2`, `CONTEXT_POLICY_VERSION`, Graph format.
- Review verdicts, Context results and Decision confirmation for the same input.
- MCP tool names and schemas, CLI commands and options. Exit codes are unchanged except for the install plan above.

## Upgrade

- From 0.3.4, 0.3.3 or 0.2.x: install the candidate, then run `duoctl status`. Nothing in Project Truth or the agent configuration is rewritten. If the index is reported stale, run `duoctl index` once.
- Re-run `duoctl install codex` or `duoctl install claude-code` to get the launcher checks. If install now stops with exit 6, follow its `--launcher npx` recommendation or install `duoctl` globally.

## Going back

0.3.4 reads the same Project Truth. It ignores the Work map files and does not have the launcher checks or the redaction above.

## Known limitations

- Real Codex and Claude Code approval prompts for the new MCP annotations are not verified. The annotations themselves were checked at the protocol level against the installed package.
- Launcher PATH behavior was measured on Windows only. `pnpm dlx` has no marker the check can see and keeps the previous behavior. `npm test`/`npm start`, `run-script` and `pnpm run` were not measured. Yarn Classic support is partial. A `node_modules/.bin` that the user put on PATH is removed too; use `--launcher npx` or a global install. POSIX runners and GUI-launched agents are not claimed.
- Work map redaction covers the Context Packet credential formats only. A key fragment that an earlier build already cut short may not be recognized. Earlier secrets in the task file stay until the map is opened or the file is next written.
- Accessibility: the automated audit is complete for 120 cases, but manual verification is not (`accessibilityVerificationComplete: false`). The browser UI focus boundary on Overview (#73) is unverified.
- Still open from 0.3.x: C259 milestone relevance WARNs (#59), C260 task scope (#58), unrelated README drift WARN (#7), stale-index recovery (#4).
- Node.js `>=24.15.0`. Package size is about 24 MB packed and 114 MB unpacked.

## Machine contract changes since 0.3.4

- MCP: annotations of `duo_get_context` and `duo_review_changes` as above. No schema change.
- UI local API: new routes and `duo.ui.decisions/1`, `duo.ui.decision-detail/1`, `duo.ui.preview/1` and the Work map payloads (additive); 400 for unexpected or repeated query parameters on three routes.
- Install verification JSON: optional `verify.warnings` with `launcher-version-mismatch` (additive). Doctor: warning `version-mismatch`, facts `cliVersion`, `serverVersion`, `resolved`, action `align-launcher` (additive). Install plan exit 6 when the agent PATH has no launcher (behavior change).
- New local regenerable files: `runtime/work-tasks.json` (`duo.work-tasks/2`) and `cache/work-map.json`. These are not public contracts.

## Release channel

- npm dist-tag `next` (`@duo-director/cli@next`). The stable `latest` stays 0.3.4.
- External Validation 01 keeps using exactly 0.2.1.

The package file, its size and hashes are listed in the GitHub prerelease `v0.4.0-rc.1`.
