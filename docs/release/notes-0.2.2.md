# DUO 0.2.2 release notes

Correctness and security patch on top of 0.2.1 (C243, C244, H-75, H-77). DUO no longer decides on Project Truth it could read only in part, and the bundled MCP SDK is updated for an upstream High advisory. Nothing else changed.

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

## Security: MCP SDK update (GHSA-6qxp-vccf-f47h)

The first 0.2.2 release candidate did not pass the release gate. Its dependency audit found the upstream High advisory [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) ("MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by the MCP server", affected `@modelcontextprotocol/client` 2.0.0 to 2.1.x, published 2026-10-06). DUO 0.2.1 bundles `@modelcontextprotocol/client` 2.1.0, so the vulnerable package is part of the published 0.2.1 package as well.

DUO uses the MCP client in one place: `duoctl install` and `duoctl doctor` start the configured DUO MCP server over stdio to check that an agent can launch it. DUO configures no OAuth and no HTTP transport, and we found no code path in DUO that reaches the affected OAuth flow. That does not rule out every way the bundled code could be used, so 0.2.2 updates the SDK instead of relying on that analysis.

0.2.2 updates the MCP SDK release group to the first patched version: `@modelcontextprotocol/client`, `@modelcontextprotocol/server` and `@modelcontextprotocol/core` 2.1.0 → 2.2.0. No other bundled package changed (67 packages, same licenses, no install scripts). The MCP server answers exactly as before: same protocol version, the same nine tools with the same schemas, the same `duo_get_status` result, and `duoctl install codex` and `duoctl install claude-code` verify as before.

## What 0.2.2 does not do

0.2.2 does not understand `forbids.imported_paths` or any other DUO 0.3 feature. On a repository that uses them it refuses to review instead of ignoring them. It adds no new feature, and the SDK update changes no DUO behavior.

## Compatibility

- Node.js `>=24.15.0`, unchanged.
- A repository whose Truth reads completely behaves exactly as with 0.2.1: same review result and JSON, same context, same commands, options and exit codes.
- `duoctl status --json` and `duo_get_status` add `truth.errors` (an empty list when nothing is wrong). `duoctl decision list --json` puts unread files in `diagnostics`. New diagnostic code `PROJECT_TRUTH_INVALID`. All formats stay `/1`.
- No re-initialization, re-adoption or migration. The analysis identity is unchanged, so an index built by 0.2.1 stays current.
- The bundled runtime dependency tree is the 0.2.1 lock with the MCP SDK at 2.2.0 instead of 2.1.0 (67 packages).
- Downgrade: 0.2.2 is the lowest version that may open a repository written by DUO 0.3. Opening such a repository with 0.2.1 or earlier is not supported.

Known limitations are those of [0.2.0](notes-0.2.0.md#known-limitations).
