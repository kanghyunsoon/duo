# DUO 0.4.0-rc.2 release notes

Release candidate on the `next` development line, for the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable release stays 0.3.5 on `latest`. This is a prerelease, not a stable release: 0.4.0 needs a separate decision.

0.4.0-rc.2 contains everything in [0.4.0-rc.1](notes-0.4.0-rc.1.md) and the [0.3.5 data-safety fix](https://github.com/kanghyunsoon/duo/blob/main/docs/release/notes-0.3.5.md) (#104, H-94) plus the changes below. The full classification is in [compatibility.md](compatibility.md#040-rc2-변경-분류-branch-next-dist-tag-next).

## What changes for users

### One-command setup (#3, #150, #152, #153)

- New command `duoctl setup` (H-102). It checks the repository, asks the same Truth questions as `init`, shows one plan (Truth files, index, Adoption Baseline and, with `--agent codex` or `--agent claude-code`, the agent configuration) and asks for one confirmation. Nothing is written before that confirmation. Non-interactive runs need `--yes`; without it setup stops with exit 6 and writes nothing.
- When a step fails after the confirmation, setup keeps what was already written correctly and prints the exact command to resume. Running setup again on a configured repository keeps existing settings and user files.
- `init`, `install` and `doctor` are unchanged and still work on their own. See [07-cli-interface.md](../07-cli-interface.md#duoctl-setup).

### The index refreshes itself in MCP when it is safe (#4, #133, #143, #148, #149, #172, #183)

- When the index is stale, `duo_get_context` and `duo_review_changes` refresh it once before answering, if that is safe. They wait at most 30 seconds for another writer. If the refresh is refused or the index is stale again afterwards, the tool returns the existing `index-required` result with a reason. A request that is cancelled, before or while it waits for the index lock, stops waiting and does not refresh (#172, #198). A refresh that already holds the lock is not interrupted.
- Results can carry the optional field `indexRefresh` (`refreshed`, `reason`). It is absent when DUO did not try to refresh.
- `duoctl index` and the MCP refresh take the same index write lock (`.duo-project/generated/index-writer.lock`). The operating system releases it when a writer dies. The CLI waits at most 5 seconds and then fails with `GRAPH_WRITE_REFUSED` and the reason. The CLI never refreshes on its own; `duoctl index` and `--refresh` behave as before.
- `duoctl status` says when only Git history moved since the last index (#175).

### Review: fewer wrong PASS and BLOCK results

- **Snapshot inputs (#160 Stage 1, H-103; Python and C/C++ follow-ups).** `review --staged` and `review --to <commit>` fail with the existing `REVIEW_SNAPSHOT_MISMATCH` (no verdict, CLI exit 1, MCP `isError`, no Review Record) when a file the forbidden-import judgment reads differs between the reviewed snapshot and the working tree. The diagnostic names those paths. This covers TS/JS resolution candidates, resolver configuration and re-export chains, Python imports, and quoted C/C++ includes. Before, some of these cases gave a wrong PASS. Unrelated working-tree changes keep the previous behavior.
- **Re-exports (#49, H-98).** A forbidden import reached through re-exports is a `forbidden-import` BLOCK when every imported name has exactly one origin. Ambiguous cases keep the `imports-through-reexport` limitation.
- **Unresolved from-side (#48, H-99 and its Amendment, #187).** When a statement only replaces a relative specifier that resolved to no file, the new forbidden pair is a WARN (`unverified-at-adoption`, limitation `imports-from-side-unresolved`) instead of a BLOCK. New statements, other files and new files stay BLOCK. In a partial clone that cannot read a blob, DUO checks file existence from the Git tree, so the result stays BLOCK.
- **Template and computed imports (#50).** `import(\`../db/x.js\`)` without substitutions is the same module reference as the string literal. A computed `import()` is recorded as unresolved and reported as `imports-unresolved`.
- **Task scope and milestones (#58, #59).** A file owned by a Symbol the task selected is in task scope. A Requirement of another milestone is shown as information (`informational: true`) and is no longer a WARN.
- **Symbol changes (#166, H-105).** A change inside a function or method also checks the IMPLEMENTS and GOVERNS links of the file that owns it. A Requirement linked only by `implements.paths` can now appear, and with no related test the result can move from PASS to WARN under the existing test-coverage rule.

### Decisions

- `forbids.importer_paths` narrows a forbidden import to importer paths (#47, H-96). Older versions refuse Truth that uses it (`PROJECT_TRUTH_INVALID`), so they never drop the Decision silently.
- Unsupported glob syntax in Decision patterns (braces, extglob groups, a leading `!`, `**` inside a segment) is refused on new proposals with `PROPOSAL_INVALID` and `PATTERN_SYNTAX_UNSUPPORTED` (#165, H-104). Decisions that were already confirmed still load unchanged, and `status`, `doctor` and `review` report the patterns that do not match as written. Brackets are literal characters and matching is case-sensitive on every OS.
- Decision TTY and permission failures explain why and what a person can do next (#155).

### Agent installation

- `duoctl install codex|claude-code --with-skill` also writes a small project skill (#8, #146, #181). It is opt-in, follows the H-94 ownership record, and is not overwritten when a skill DUO did not write is already there.
- A second `install remove` says DUO is not configured (#116). Valued global options such as `--root` and `--locale` work before the command (#122).
- The published `package.json` has `mcpName` (`io.github.kanghyunsoon/duo`), which the MCP Registry needs. Registering in the Registry is a separate step and is not part of this release.

### Local UI recovery (#178, #179)

- A malformed entity address (for example `/entity/%`) or an API response without the expected success envelope shows recovery guidance (`UI_INVALID_RESPONSE`) instead of an empty page. An unexpected rendering error is contained to the page.
- The Work map shows that it is reconnecting when the connection drops. After two failed revision checks it warns that the information shown may be stale, and it checks again every 5 seconds. Screen-reader announcements of these messages are not verified (#101).

## Index after upgrading

The TS/JS analyzer identity changed, so an index made by an earlier version is reported as `stale`. Run `duoctl index` once. A Python or C/C++ repository whose files do not need new analysis is also reported `stale` until that one run (#201); the run rewrites only the index state and the next `duoctl index` writes nothing. In MCP, the first safe call refreshes it.

## Unchanged

- Project Truth `schema_version: 1` (new optional field `forbids.importer_paths`), Decision Lock format and digests, `duo.context/1`, `duo.context-packet/1`, `duo.gap-assessment/1`, `duo.review-record/1`, `duo.adoption-baseline/2`, the Graph format and the index state version. `duo.review/1`, `duo.status/1` and `duo.agent-integration-plan/1` keep their names and gain only optional fields.
- The nine MCP tools and their input schemas. CLI exit codes. Runtime dependencies: the release lock has the same 67 packages as 0.4.0-rc.1.

## Upgrade

- From 0.4.0-rc.1, 0.3.5 or 0.3.4: install the candidate, run `duoctl status`, then `duoctl index` once if it reports `stale`. Project Truth, the lock and the agent configuration are not rewritten.
- Re-run `duoctl install <agent>` only if you want `--with-skill` or to repair the agent configuration.

## Going back

- 0.4.0-rc.1 and 0.3.x read the same Project Truth unless it uses `forbids.importer_paths`; then they stop with `PROJECT_TRUTH_INVALID`. They give the earlier verdicts for the cases above.
- 0.4.0-rc.1 and 0.3.4 have no ownership record and still have #104. 0.3.5 reads the record, but treats one that lists a skill as invalid and deletes nothing on remove (H-94 fallback).
- An older version may rebuild an index written by this candidate on its next `duoctl index`.

## Known limitations

- #160 Stage 2 is not complete. Review does not analyze the reviewed snapshot directly: when an input of the judgment differs from the working tree, it fails with `REVIEW_SNAPSHOT_MISMATCH` instead of giving a verdict.
- #151 (Stage B is not included): a `tsconfig.json` or `jsconfig.json` that Git ignores or `index.exclude` leaves out, created after an index, does not make the index stale. `status` reports `current` and MCP does not refresh. Running `duoctl index` resolves imports again with it (Stage A, #192). A config that only changes through an `extends` target created later is not picked up.
- The 30-second MCP lock wait is an initial value from the current measurements and is not guaranteed to be shorter than every MCP client timeout.
- Real Codex and Claude Code approval prompts, Claude Code loading of the `--with-skill` skill during a task, and manual accessibility checks (`accessibilityVerificationComplete: false`) are still not verified.
- Carried over from 0.4.0-rc.1: launcher PATH behavior measured on Windows only, and Work map redaction limited to the known credential formats.
- Still open: editing an unrelated part of the README after setup can make reviews WARN (#7).
- On Windows, a nearest `tsconfig.json` or `jsconfig.json` with a JSON syntax error makes indexing fail with a TypeScript "Debug Failure" instead of reporting `TSCONFIG_INVALID` (#205). 0.4.0-rc.1 and 0.3.5 have the same problem. Fix the JSON syntax and run `duoctl index` again.
- Node.js `>=24.15.0`.

## Release channel

- npm dist-tag `next` (`@duo-director/cli@next`). The stable `latest` stays 0.3.5.
- The package file, its size and hashes will be listed in the GitHub prerelease `v0.4.0-rc.2` after publication.
