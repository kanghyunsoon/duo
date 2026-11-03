# Issue #104: preserve files that existed before agent installation (H-94)

Status: **Implemented against H-94** ([Decision PR #117](https://github.com/kanghyunsoon/duo/pull/117) merged on `next`, [review on PR #113](https://github.com/kanghyunsoon/duo/pull/113#pullrequestreview-5661245527)).

- GitHub: [#104](https://github.com/kanghyunsoon/duo/issues/104) · [PR #113](https://github.com/kanghyunsoon/duo/pull/113).
- Jira: [S15P31A106-348](https://ssafy.atlassian.net/browse/S15P31A106-348).
- Base: `next` after #105 (`e0756e5`) and #56 (`1d5fb53`).
- Environment: Windows 11, Node 24.18.0, pnpm 11.25.0. Tests use temporary project roots and a fake launcher; no account, model call or real agent configuration is used.

## Reproduction and regression suite

The #27 suite from [PR #105](https://github.com/kanghyunsoon/duo/pull/105) (`packages/integration/src/agents/lifecycle.test.ts`) is updated so its pinned `#104` assertion and `it.todo` become real preservation tests covering pre-existing `.mcp.json` (`{"mcpServers": {}}`), 0-byte `CLAUDE.md`, 0-byte `AGENTS.md` and empty `.codex/config.toml`, plus byte-for-byte restoration of a hand-formatted `.mcp.json` when untouched since install.

`packages/integration/src/agents/removal-ownership.test.ts` supplements that suite with per-file mixed ownership, `postSha256` identity verification before whole-file deletion, repeated install/update preservation of `existedBefore`, tracked and untracked files, LF and CRLF line endings, missing or corrupted ownership records, unidentifiable managed areas, symlinked record paths, stale plans, same-clock backup protection, concurrent edits during backup I/O, and rollback safety.

## H-94 Ownership record and removal rules

Content alone never decides whether a file may be deleted. When `applyAgentIntegration` installs or updates an agent in an initialized DUO project, it writes `.duo-project/runtime/agent-integration/<agent>.json` atomically through `guardWrite(..., "regenerable")`:

```json
{
  "format": "duo.agent-file-ownership/1",
  "agent": "claude-code",
  "created": [".mcp.json", "CLAUDE.md"],
  "targets": {
    ".mcp.json": {
      "existedBefore": false,
      "preSha256": null,
      "backup": null,
      "postSha256": "<sha256>"
    },
    "CLAUDE.md": {
      "existedBefore": true,
      "preSha256": "<sha256>",
      "backup": ".duo-project/runtime/backup/agent-claude-code-<stamp>/CLAUDE.md",
      "postSha256": "<sha256>"
    }
  },
  "digest": "<sha256 of canonical body>"
}
```

- **Allowlisted targets and digests only (H-94 (1), (3), (7)).** The record accepts only that agent's `mcpTarget` and `bridgeTarget`, verified by `digest`. It stores no file contents, secrets, credentials or absolute paths.
- **Whole-file deletion requires creation evidence + matching `postSha256` (H-94 (3)).** A file is deleted only when a valid record marks `existedBefore: false` for that target, its current sha256 equals `postSha256`, and nothing remains after removing DUO's part.
- **Re-install and update keep the first answer (H-94 (11)).** Updating an existing installation preserves `existedBefore`, `preSha256` and `backup` for pre-existing files, and keeps `existedBefore: false` for DUO-created files that still hold only DUO content while refreshing `postSha256`.
- **Exact original bytes (H-94 (8), (9)).** When `existedBefore: true`, the current file still matches `postSha256`, and the original backup exists with sha256 equal to `preSha256` (and held no prior DUO entry/block), removal restores those exact bytes (including hand-formatted `.mcp.json`). If the user edited the file after install, removal strips only DUO's entry/block and never overwrites user edits with the backup.
- **Missing or invalid record fallback (H-94 (5)-(7), (10)).** When the record is missing (older DUO install, another clone, cleaned runtime) or fails validation (corrupted JSON, wrong digest, unknown format, symlink), no file is deleted. If DUO's entry or block is clearly identifiable, removal strips only that part, keeps the file (`modify`) and adds a warning explaining why (`no install record` or `invalid install record`). If the managed area is malformed or cannot be parsed safely, removal reports `AGENT_INTEGRATION_CONFLICT` and changes nothing.
- **Retiring the record on remove (including `modified since DUO installed it`).** Successful removal always deletes `.duo-project/runtime/agent-integration/<agent>.json`, even when a file originally created by DUO was kept because the user edited it after install (`modified since DUO installed it`). Once DUO is uninstalled and the kept file holds only the user's own content, any later `duoctl install` observes it as a pre-existing user file (`existedBefore: true`) and will never delete it.
- **Plan = apply (H-94 (6)).** `planAgentRemoval` and `applyAgentIntegration` share `decideTargetRemoval`, and `applyAgentIntegration` verifies that every target's computed action matches the planned action before writing. Keeping a file uses the existing `modify` action in `duo.agent-integration-plan/1`; adding the runtime record to `plan.files` is an internal stale-plan check within the existing `files: readonly FileSnapshot[]` contract.

## Validation

- `pnpm exec vitest run packages/integration/src/agents/ tests/install/install.e2e.test.ts`: 6 files, 105 tests passed.
- `pnpm check:boundaries`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm docs:validate` and `git diff --check`: passed.
- 3-OS GitHub Actions CI (`verify` on Ubuntu, Windows and macOS): passed on `943960e` (run [40426418776](https://github.com/kanghyunsoon/duo/actions/runs/40426418776)).
