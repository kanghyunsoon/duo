# DUO 0.3.0-rc.2 release notes

Release candidate on the `next` development line, for the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable line is 0.2.2 on `latest`, and this candidate does not change that. It is not a stable release: 0.3.0 needs a separate decision. External Validation 01 keeps using exactly 0.2.1.

0.3.0-rc.1 was never published. Its candidate (commit `82246f4`) bundled `@modelcontextprotocol/client` 2.1.0, which is affected by the High advisory GHSA-6qxp-vccf-f47h, so it did not pass the release gate (H-77). rc.2 is that candidate with the MCP SDK security update and nothing else added.

## What changes for users

1. **Agents can propose complete enforceable Decisions** (H-71). `duo_propose_decision` accepts `forbids`, `enforcement` and `supersedes`. A proposal has no authority: it changes no verdict until a person confirms it, and no MCP tool can confirm, reject or write a Decision. The MCP tool count stays nine.
2. **Humans confirm exactly the candidate they reviewed** (Informed Confirm). `duoctl decision confirm` and the Web UI show the whole candidate before the ID is typed again: title, question, answer, rationale, governs, forbids, the forbids scope, enforcement, the superseded Decision and what happens to it, staleness, the proposer (an audit label) and the expected Decision ID. The confirm is bound to that preview's digest: if the candidate changed in between, nothing is confirmed (`DECISION_CONFIRM_PREVIEW_CHANGED`).
3. **Confirmed Decisions can block forbidden repository imports** (H-72). `forbids.imported_paths` takes repository path patterns. A changed import line whose module reference resolves to exactly one repository file matching a pattern is a `decision-forbids-import` CONFLICT (reason `forbidden-import`); with `enforcement: block` it can block.
4. **Explicitly named task and requirement seeds keep their full specification** (H-76, F-23). When the task text names an Issue or Requirement by its exact ID, its full text and all its Acceptance Criteria get the context budget before lower-ranked evidence such as tests or other issues. If it cannot fit, the packet says so (`explicit-seed-truncated`) and keeps the largest representation that fits; the budget is never exceeded.

People also read provenance in words (H-73): `not-in-adoption-baseline`, `in-adoption-baseline`, `in-adoption-baseline, touched`, `baseline-unverified`. JSON and MCP structured content keep `introduced`, `pre-existing`, `pre-existing-touched` and `unverified-at-adoption` with the same meaning.

## Correctness

Invalid or partial Project Truth now fails closed (T40, C243). A Decision file DUO cannot read completely (an unknown field, malformed YAML, a wrong type) is no longer left out silently. Review and context fail with `PROJECT_TRUTH_INVALID` followed by each file error (exit code 1, no verdict, no packet), the Adoption Baseline is not captured, and Decision confirm, reject and preview are refused. `status` lists the errors (`truth.errors`), `doctor` reports `truth.project: invalid` (exit code 6), `decision list` names the unread files, MCP `duo_review_changes` returns a tool error without a ReviewResult and the Web UI shows the error without a verdict. Proposing still works, and DUO never repairs or removes the file. The same fix is in the stable 0.2.2.

## Security

The bundled MCP SDK (`@modelcontextprotocol/client`, `@modelcontextprotocol/server`, `@modelcontextprotocol/core`) is updated from 2.1.0 to 2.2.0 for the upstream High advisory [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) ("MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by the MCP server"). DUO uses the MCP client only to start its own MCP server over stdio when `duoctl install` and `duoctl doctor` check an agent connection; it configures no OAuth and no HTTP transport. That analysis does not rule out every use of the bundled code, so the package is updated. No other bundled package changed (67 packages, same licenses, no install scripts), and the MCP server answers as before. Stable 0.2.2 carries the same update.

## Semantics of `imported_paths`

- It checks exact resolved imports on changed lines. An existing import is reported when a change edits that line.
- It does not prove that the change created the relation. `introduced` (shown as `not-in-adoption-baseline`) means the violation is absent from the Adoption Baseline.
- Forbids scope is repository-wide. `governs` records what a Decision is about and does not narrow its forbids; the confirm preview says so (`Forbids scope`).
- TypeScript and JavaScript imports of every form are checked, type-only imports included (import, export-from, dynamic import, require); Python and C++ where DUO resolves the module. Unresolved and ambiguous imports never block; the review lists them as limitations.

## Known limitations

- Barrel and re-export files: an import through them is not seen as an import of the file behind them (false negatives).
- Java and C# imports are not checked by `imported_paths`.
- C239: a correct change can still get a review WARN from a missing-intent gap.
- F-07: approval friction. Each pending Decision is confirmed with its own terminal command (nine pending Decisions take nine commands); there is no batch confirm.
- F-25: Decisions that govern paths are not always pulled into the context of a task about those paths.
- Supersession history is not shown on the review screen (C241).
- Agents read the structured provenance value `introduced` and may still describe it as "introduced by this change".
- Node.js `>=24.15.0`.
- Package size: about 24 MB packed and 114 MB unpacked (7,468 files), because the 67 runtime dependencies are bundled.

## Compatibility

- A project made by 0.2.1 or 0.2.2 opens in 0.3.0-rc.2 without migration and nothing is rewritten: Decisions, locks, proposals, Adoption Baselines, Review Records, index state and agent configuration are read as they are.
- 0.2.2 is the fail-closed safety floor and the current stable release. It does not understand `imported_paths`; it refuses to review a repository that uses it instead of silently ignoring the Decision.
- Opening a repository that uses 0.3-only Truth (`forbids.imported_paths`) with 0.2.1 or older is not supported. Those versions leave such a Decision out without a visible warning, and a review can pass a change it forbids.
- To go back to 0.2.x completely, first supersede Decisions that use `imported_paths` with Decisions that do not.

## Machine contract changes

- Decision and proposal schema: optional `forbids.imported_paths`. A Decision without it has the same lock digest as before.
- MCP `duo_propose_decision`: optional `forbids`, `enforcement`, `supersedes`; calls in the 0.2.x form are accepted unchanged.
- Review: rule value `decision-forbids-import`. `duo.review/1`, the provenance values and `blockEligible` are unchanged.
- Adoption Baseline: optional `evaluatedRules` on new captures; existing baselines are never rewritten.
- Diagnostics: `DECISION_CONFIRM_PREVIEW_CHANGED`, `PROJECT_TRUTH_INVALID`. Context limitation `explicit-seed-truncated`.
- `duo.status/1`: `truth.errors` (additive, also in 0.2.2).
- Local UI HTTP API: `POST /api/proposals/<id>/confirm` requires `previewDigest` (the bundled UI sends it).

The package file, its size and hashes are listed in the GitHub prerelease `v0.3.0-rc.2`.
