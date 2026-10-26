# Issue #104: preserve files that existed before agent installation

Status: **Draft proposal for maintainer review**, not an adopted Decision or a release authorization.

- GitHub: [#104](https://github.com/kanghyunsoon/duo/issues/104).
- Jira: [S15P31A106-348](https://ssafy.atlassian.net/browse/S15P31A106-348).
- Base: `next` at `beac63aee7b5df68ef463c82bfaa6bd7ce3baf2c`.
- Environment: Windows, Node 24.18.0, pnpm 11.25.0. Tests use temporary project roots and a fake launcher; no account, model call or real agent configuration is used.

## Reproduction

`removal-ownership.test.ts` exercises the same plan/apply API as the CLI. Before the fix, both preservation cases fail: removal plans delete `.codex/config.toml` and `AGENTS.md`, or `.mcp.json` and `CLAUDE.md`, although the files existed before install. The two cases starting without files pass and must keep passing.

The tests run install, install again, an older bridge update, remove, then a second remove. An existing `.mcp.json` starts as `{"mcpServers": {}}`; the text files start at zero bytes.

## Proposed behavior

Content alone cannot distinguish a user file from a file DUO created. The shared integration layer records only the latter target paths in `.duo-project/runtime/agent-integration/<agent>.json`:

```json
{
  "format": "duo.agent-file-ownership/1",
  "created": [".mcp.json", "CLAUDE.md"]
}
```

The allowed paths are limited to that agent's two targets. The record contains no original contents, timestamps, credentials or absolute paths. It is local runtime state, not Project Truth, and need not be committed. Losing it reduces cleanup; it cannot grant permission to delete files.

| Starting state | Proposed remove behavior |
|---|---|
| Existing empty configuration or bridge | Remove DUO's content and keep the empty file |
| Target absent before install | Delete it only if no user content remains |
| One target existed, the other was absent | Decide independently for each target |
| Human additions after install | Retain them even in a file DUO created |
| Old install, missing record, or another clone | Keep empty files and warn that ownership is unknown |
| Invalid or redirected ownership record | Block mutations; do not infer ownership |

Repeated installs and bridge updates retain the record. Successful removal retires it so a subsequent install observes the current user files anew. A no-op still writes nothing. The plan's `files` snapshots include the record hash; its public user-file action lists and apply `changed`/`backups` lists still describe only configuration and bridge files. Existing write guards, backups and rollback apply, including rollback when persisting or retiring the record fails.

## Review decisions

1. Approve or replace the local creation record approach.
2. Approve the safe fallback for older installs: keeping empty files changes the former content-only deletion behavior. The warning explains it rather than claiming DUO knows the original owner.
3. Decide release inclusion. This patch does not amend the confirmed ADR-011 or confirm a new Decision.

The alternative of always keeping empty files is smaller but also leaves files behind on every fresh install/remove. Inferring ownership from dated backups cannot distinguish all repeated-install histories. The proposal uses explicit creation evidence to preserve fresh cleanup and existing empty files together.

## Validation and integration

The regression suite covers both agents, mixed ownership, updates, human additions, old installs, malformed records, stale plans, symlink guards, install rollback and remove rollback. Existing #6 cleanup coverage now performs a real install, rather than constructing files without creation evidence.

[PR #105](https://github.com/kanghyunsoon/duo/pull/105) remains separate. Its current-behavior test for #104 and `it.todo` will need to become the preservation expectation when the branches are integrated; do not merge both expectations unchanged. #31, the second-remove message (#109), launcher selection, and setup/index behavior are outside this patch.
