# DUO 0.3.0-rc.6 release notes

Release candidate on the `next` development line, published to the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable release stays 0.2.2 on `latest`. This is a prerelease, not a stable release: 0.3.0 needs a separate decision. External Validation 01 keeps using exactly 0.2.1.

rc.6 contains everything in [0.3.0-rc.5](notes-0.3.0-rc.5.md) plus the changes below. It is a new build with its own version, commit and hashes; earlier candidates stay published as they were.

## What changes for users

### Review verdict signal quality (H-80, C239)

- A `missing-intent` Knowledge Gap means the context DUO assembled for the review holds no confirmed Requirement or Decision. It is a coverage signal, not a finding.
- The gap is still reported everywhere it was: `ReviewResult.gaps`, the CLI, `--json`, the MCP payload, the Web UI and the gap summary of a Review Record. Its kind, reasons and action (`surface`) are unchanged.
- The gap alone no longer makes a review WARN. With no other WARN, ASK or BLOCK basis the verdict is PASS, and the gap is still shown next to it. PASS keeps its meaning: no project-direction violation was found in the available evidence. It does not mean the change is bug-free or fully covered by Project Truth.
- Every other surfaced gap still warns: a pending Decision reached only by search, and a related declared `UNKNOWN`.
- ASK and BLOCK are unchanged: an ambiguous target, an unknown explicit ID, an explicitly related pending Decision or a direct declared `UNKNOWN` still asks, and claims, evidence and blocking rules are the same.
- A review whose only basis was the missing-intent gap now exits 0 with `--fail-on warn` and with `--strict` (before: 2). `--strict` is still the same as `--fail-on warn`, and a real WARN still exits 2.
- Recording such a review gives a new Review Record ID, because the record body holds the verdict and its basis. This also happens when the verdict stays BLOCK or ASK and only the gap left the warn basis. Existing records are never rewritten and still read as before.

### Agent visibility

- The text summary of the MCP tool `duo_review_changes` now lists Knowledge Gaps with the same wording as the CLI: a `Question for the human: …` line for an ASK, and one line per surfaced gap. An agent that reads only the text now sees the gap behind a PASS and the question behind an ASK.
- The structured MCP payload is unchanged, and there are still nine tools.

### Wording precision (C258)

- The missing-intent sentence used to say "No confirmed Requirement or Decision is linked to this task.". That claimed a task where a review may have none, and read as if no confirmed Decision existed even when review rules had applied one.
- It now reads "The context DUO assembled contains no confirmed Requirement or Decision intent." (Korean: "DUO가 구성한 Context에 확정된 Requirement/Decision intent가 없습니다.").
- The same sentence is used by `duoctl review`, `duoctl context` and the MCP review and context text. In `duo.context/1` the rendered string `gaps.surfaced[].note` holds the new sentence; its field and type are unchanged.
- The wording change does not touch Review Records: they keep language-neutral gap fields only, so their body and ID do not depend on it.

## Known limitations

- Other surfaced gaps (a pending Decision found only by search, a related declared `UNKNOWN`) still make a review WARN; whether they are noise in practice has not been evaluated.
- Root files whose name has no dot (`LICENSE`, `Dockerfile`, `Makefile`) need `./` in a task to be read as the file.
- Secret files (`.env*` and the other secret-file patterns) are not indexed and never appear in context.
- `imported_paths`: an import through a barrel or re-export file is not seen as an import of the file behind it (false negatives). Java and C# imports are not checked.
- Agents read the structured provenance value `introduced` and may still describe it as "introduced by this change".
- Node.js `>=24.15.0`.
- Package size: about 24 MB packed and 114 MB unpacked, because the 67 runtime dependencies are bundled.

## Compatibility

- A project made by 0.2.1, 0.2.2 or an earlier 0.3.0 candidate opens in 0.3.0-rc.6 without migration and nothing is rewritten. From rc.5 nothing in the Project Truth, the index or the agent configuration changes; from 0.2.x the index is reported stale once (run `duoctl index` once).
- The H-80 change is a behavior correction inside the same formats: for the same input a review can now be PASS where it was WARN. It is not a format change.
- 0.2.2 remains the fail-closed safety floor and the current stable release: it refuses to review or build context for a repository that uses 0.3-only Truth (`forbids.imported_paths`, Issue `implements.paths`) with `PROJECT_TRUTH_INVALID`. rc.6 adds no Truth fields.
- Opening a repository that uses 0.3-only Truth with 0.2.1 or older is not supported: those versions can leave such a Decision or Issue out without a visible warning.

## Machine contract changes since rc.5

- Review: `verdictBasis.warn` no longer lists missing-intent gap IDs, so `verdict` can be PASS where it was WARN. `duo.review/1`, `duo.gap-assessment/1` and `duo.review-record/1` keep their formats.
- Context: the rendered string `gaps.surfaced[].note` of `duo.context/1` changes for missing-intent. `CONTEXT_POLICY_VERSION` stays 8 and Context Packets are unchanged.
- Unchanged: Truth schema, Graph schema and relation rules, `duo.context-packet/1`, Decision lock digests, MCP (nine tools, same input and output schemas), CLI commands and exit codes.

## Release channel

- npm dist-tag `next` (`@duo-director/cli@next`). The stable `latest` stays 0.2.2.
- External Validation 01 keeps using exactly 0.2.1; its participants are not asked to use rc.6.

The package file, its size and hashes are listed in the GitHub prerelease `v0.3.0-rc.6`.
