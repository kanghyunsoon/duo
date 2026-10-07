# DUO 0.2.2 release notes

Correctness patch on top of 0.2.1 (C243, C244, H-75). DUO no longer decides on Project Truth it could read only in part. Nothing else changed.

## Problem

When a file under `.duo-project/` could not be read completely, for example a confirmed Decision with a field DUO does not know, malformed YAML or a value of the wrong type, the loader left that file out and returned the rest. Review, context and doctor then used what was left and did not report the missing file. A confirmed `enforcement: block` Decision could disappear this way, and `duoctl review` passed a change that Decision forbids. `duoctl status` only showed a lower Decision count and `duoctl doctor` said the project was ready.

The same thing happens when a repository that a newer DUO wrote is opened with 0.2.1. DUO 0.3 adds `forbids.imported_paths`; 0.2.1 drops a Decision that uses it and reviews without it (no claim, no warning).

## Fix

The loader stays tolerant, so `status`, `index`, `doctor` and the UI still open a project with a broken file. Operations that decide refuse to run on partial Truth:

- `duoctl review` and `duoctl context` fail with `PROJECT_TRUTH_INVALID` followed by each file error (code, file, line), exit code 1, and no verdict or packet. `--fail-on` does not turn this into a pass.
- Adoption Baseline capture and Decision confirm and reject refuse the same way. Proposing a Decision still works: a proposal has no authority, and the change that fixes the Truth may need one.
- `duoctl status` lists the files it could not read (`truth.errors` in `--json`). `duoctl decision list` names them.
- `duoctl doctor` reports `truth.project` as invalid with the problem codes and files, never ready.
- The MCP review tool returns an error result without `structuredContent`; `duo_get_status` carries `truth.errors`. The UI review page shows "Review not run: no verdict" with the errors.
- DUO does not repair, remove or rewrite the broken file.

Every loader error blocks except `BROKEN_REFERENCE` and `REFERENCE_TYPE_MISMATCH`, which leave all file content in place and keep their current behavior.

## What 0.2.2 does not do

0.2.2 does not understand `forbids.imported_paths` or any other DUO 0.3 feature. On a repository that uses them it refuses to review instead of ignoring them. It adds no new feature.

## Compatibility

- Node.js `>=24.15.0`, unchanged.
- A repository whose Truth reads completely behaves exactly as with 0.2.1: same review result and JSON, same context, same commands, options and exit codes.
- `duoctl status --json` and `duo_get_status` add `truth.errors` (an empty list when nothing is wrong). `duoctl decision list --json` puts unread files in `diagnostics`. New diagnostic code `PROJECT_TRUTH_INVALID`. All formats stay `/1`.
- No re-initialization, re-adoption or migration. The analysis identity is unchanged, so an index built by 0.2.1 stays current.
- The bundled runtime dependency tree is the 0.2.1 lock (67 packages).
- Downgrade: 0.2.2 is the lowest version that may open a repository written by DUO 0.3. Opening such a repository with 0.2.1 or earlier is not supported.

Known limitations are those of [0.2.0](notes-0.2.0.md#known-limitations).
