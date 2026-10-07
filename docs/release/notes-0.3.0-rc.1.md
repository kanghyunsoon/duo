# DUO 0.3.0-rc.1 release notes (draft, never published)

> Not published. The 0.3.0-rc.1 candidate (`82246f4`) did not pass the release gate because its bundled MCP SDK is affected by GHSA-6qxp-vccf-f47h (H-77). It is kept as history; [0.3.0-rc.2](notes-0.3.0-rc.2.md) replaces it.

Release candidate on the `next` development line. Not published. When it is, it goes to the npm dist-tag `next` (`npm install -g @duo-director/cli@next`); `latest` stays 0.2.1, and External Validation 01 keeps using exactly 0.2.1.

## What changes for users

1. **Agents propose complete Decisions** (H-71). `duo_propose_decision` accepts `forbids`, `enforcement` and `supersedes`. A proposal still has no authority: it changes no verdict until a person confirms it, and no MCP tool can confirm, reject or write a Decision. The tool count stays nine.
2. **People confirm exactly what they reviewed** (Informed Confirm, T34). `duoctl decision confirm` and the Web UI show the whole candidate before the ID is typed again: title, question, answer, rationale, governs, forbids, the forbids scope, enforcement, the superseded Decision and what happens to it, staleness, the proposer (an audit label) and the expected Decision ID. The confirm is bound to that preview: if the candidate changed in between, nothing is confirmed (`DECISION_CONFIRM_PREVIEW_CHANGED`).
3. **Confirmed Decisions can block forbidden repository imports** (H-72). `forbids.imported_paths` takes repository path patterns. A changed import line whose module reference resolves to exactly one repository file matching a pattern is a `decision-forbids-import` CONFLICT (reason `forbidden-import`); with `enforcement: block` it can block.
   - Only changed lines are checked. An existing import is reported when a change edits that line. DUO does not claim that the change created the import.
   - TypeScript and JavaScript (import, export-from, dynamic import, require, type-only included); Python and C++ where DUO resolves the module. Java and C# imports are not checked. Unresolved and ambiguous imports never block; the review lists them as limitations.
   - An import through a barrel or re-export file is not seen as an import of the file behind it.
   - Forbids apply to the whole repository. `governs` records what a Decision is about and does not narrow its forbids; the preview says so (`Forbids scope`).
4. **Provenance in words** (H-73). People read `not-in-adoption-baseline`, `in-adoption-baseline`, `in-adoption-baseline, touched` and `baseline-unverified` (Korean with `--locale ko`). JSON and MCP structured content keep `introduced`, `pre-existing`, `pre-existing-touched` and `unverified-at-adoption`, with the same meaning: `introduced` means the violation is absent from the Adoption Baseline, not that this change created it.
5. **Partial Project Truth never produces a verdict** (T40). Before, a Decision file DUO could not read (an unknown field, malformed YAML, a wrong type) was left out silently: `status` showed one Decision fewer, `doctor` said ready and a review could PASS a change that Decision forbids. Now review and context fail (exit code 1, `PROJECT_TRUTH_INVALID` followed by each file error), the Adoption Baseline is not captured, and Decision confirm, reject and preview are refused. `status` lists the errors (`truth.errors`), `doctor` reports `truth.project: invalid` (exit code 6), `decision list` names the unread files, MCP `duo_review_changes` returns a tool error without a ReviewResult and the Web UI shows the error without a verdict. Proposing still works. DUO never repairs or removes the file. References to an undefined ID (`BROKEN_REFERENCE`, `REFERENCE_TYPE_MISMATCH`) remove no content and do not block.

## Machine contract changes

- Decision and proposal schema: optional `forbids.imported_paths`. A Decision without it has the same lock digest as before.
- MCP `duo_propose_decision`: optional `forbids`, `enforcement`, `supersedes`; `forbids.symbols` refuses a DUO `path#symbol` reference. Calls in the 0.2.1 form are accepted unchanged.
- Review: rule value `decision-forbids-import` in `claims[].rule`. `duo.review/1`, the provenance values and `blockEligible` are unchanged.
- Adoption Baseline: optional `evaluatedRules` (new captures only; existing baselines are read as not having evaluated the import rule and are never rewritten).
- Diagnostics: new `DECISION_CONFIRM_PREVIEW_CHANGED` and `PROJECT_TRUTH_INVALID` (both errors).
- `duo.status/1`: `truth.errors` (additive).
- Exit codes: review and context exit 1 instead of producing a result when Project Truth is partial. Everything else is unchanged.
- Local UI HTTP API: `POST /api/proposals/<id>/confirm` requires `previewDigest` (the bundled UI sends it).

## Compatibility

- Reading 0.2.x data needs no migration and writes nothing: Decisions, locks, proposals, Adoption Baselines, Review Records, index state and agent configuration from 0.2.1 are read as they are (verified with a repository made by the published 0.2.1).
- Node.js `>=24.15.0`, unchanged.

## Downgrade

Do not open a repository that uses a 0.3-only Decision field (`forbids.imported_paths`) with DUO 0.2.1 or older. Those versions leave such a Decision out without a visible warning, and a review can pass a change it forbids. The proposed downgrade floor is a 0.2.x patch that refuses partial Truth (0.2.2, not released; it needs its own decision). Until such a version exists there is no supported downgrade for a repository that uses these fields: stay on the release candidate, or first supersede those Decisions with ones that do not use the field.

## Known limitations

As in 0.2.1, plus: `imported_paths` checks changed lines only, does not check Java or C# imports, does not see imports through barrel files and has no importer scope. Supersession history is not shown on the review screen (C241).
