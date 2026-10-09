# DUO 0.3.0-rc.4 release notes

Release candidate on the `next` development line, published to the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable release stays 0.2.2 on `latest`. This is a prerelease, not a stable release: 0.3.0 needs a separate decision. External Validation 01 keeps using exactly 0.2.1.

rc.4 contains everything in [0.3.0-rc.3](notes-0.3.0-rc.3.md) plus the changes below. It is a new build with its own version, commit and hashes; rc.3 stays published as it was.

## What changes for users

### Human Decision workflow

- **`duoctl decision review-pending`** reviews every pending Decision proposal in one terminal session. It shows each proposal with the same informed preview as `duoctl decision confirm`, then asks which to confirm: a list of IDs, `all`, or `one` to decide proposal by proposal (`skip` keeps a proposal pending). Proposals you do not select stay pending.
- Authority does not change. Only a person at a terminal can confirm (without a TTY, or with `--non-interactive`, the command refuses: `CLI_TTY_REQUIRED`). You type the selected IDs again before anything is written. Each confirmation is bound to the digest of the candidate you saw: a proposal that changed after the preview is not confirmed (`DECISION_CONFIRM_PREVIEW_CHANGED`) and the others go on.
- Before a multi-proposal confirmation, DUO tries the session on a temporary copy and shows what an earlier confirmation changes for a later one. When one proposal's result depends on another in the same session (two proposals supersede the same Decision, or one supersedes a Decision the session creates), the whole session is refused (`DECISION_SESSION_CONFLICT`) and you confirm them one at a time.
- A Decision confirmed this way is the same as one confirmed with `decision confirm` (ID, lock, proposer, confirmer, supersession). Agents still cannot confirm: there is no confirm tool in MCP, and the MCP tool count stays nine.

### Issue task scope

- An Issue may declare the repository paths it implements: `implements.paths` (optional, path patterns). The files matching them are linked to the Issue (File IMPLEMENTS Issue, declared).
- A task that names only the Issue ID (for example `duoctl context TASK-015`) now reaches those files and the Decisions that govern them. Before, a Decision governing those paths was missing from that context unless the task text also named a path.
- DUO does not guess paths from the Issue's prose, and an Issue does not inherit the scope of the Issues it depends on. An Issue without the field behaves as before.

### Context precision

- A token in the task that resolves exactly to an existing file is no longer also used as keyword search input. Its path words (`src`, `auth`, `ts`) used to pull in unrelated files and the Decisions governing them.
- Repository-relative paths written as `./src/auth/session.ts`, `src\auth\session.ts` or `.\src\auth\session.ts` resolve to the same file as `src/auth/session.ts`.
- A token that resolves exactly to a symbol (a unique qualified name such as `Session.open`, a unique name, or one linked C++ declaration and definition) is no longer also used as keyword input. In a measured fixture, `Session.open` used to bring in an audit module named `openSessionAudit` and the Decision governing it; it no longer does.
- Tokens that resolve to nothing, and ambiguous names, keep their previous behavior: unresolved words stay keyword input, and an ambiguous name still asks which one you mean when nothing else in the task is exact. The other words of the task are always searched.
- The context policy version is 6, so context packets cached by earlier versions are rebuilt.

### Review explainability

- A review claim about a Decision now says where that Decision stands: `current authority`, `supersedes D-001`, or `superseded · superseded by D-002`. The CLI prints it under the claim (also in Korean with `--locale ko`), the MCP text summary adds it to the claim's tags, and the Web UI shows it under the claim's subject.
- The facts come from the Decision files as written (direct relations only, no history inference). They explain which Decision the verdict used; they are not a new verdict signal. Verdicts, claims, claim IDs, evidence and exit codes are unchanged.
- Review Records stay the same: the lifecycle facts are not written to them, so a recorded review keeps the same ID. Recorded reviews in the Web UI therefore do not show these lines.

## Carried forward from rc.3

- Invalid or partial Project Truth fails closed (`PROJECT_TRUTH_INVALID`): no verdict, no context packet, no Decision confirm. The same fix is in the stable 0.2.2.
- The bundled MCP SDK is 2.2.0 (High advisory GHSA-6qxp-vccf-f47h, H-77). No dependency changed since rc.3 (67 bundled packages, no install scripts).
- `forbids.imported_paths` checks exact resolved imports on changed lines. It does not prove the change created the import, its scope is repository-wide, and unresolved or ambiguous imports never block.
- A task that names an Issue or Requirement by its exact ID keeps its full specification in the context before lower-ranked evidence (H-76).

## Known limitations

- C239: a correct change can still get a review WARN from a missing-intent gap.
- `imported_paths`: an import through a barrel or re-export file is not seen as an import of the file behind it (false negatives). Java and C# imports are not checked.
- A path whose first directory starts with a dot (for example `.github/workflows/ci.yml`) and a root file without a directory (for example `package.json`) are not read as exact paths in a task; they are used as keyword input.
- Agents read the structured provenance value `introduced` and may still describe it as "introduced by this change".
- Node.js `>=24.15.0`.
- Package size: about 24 MB packed and 114 MB unpacked, because the 67 runtime dependencies are bundled.

## Compatibility

- A project made by 0.2.1, 0.2.2 or an earlier 0.3.0 candidate opens in 0.3.0-rc.4 without migration and nothing is rewritten: Decisions, locks, proposals, Adoption Baselines, Review Records and agent configuration are read as they are. The index is reported stale once after the upgrade (the relation rules changed for `implements.paths`); run `duoctl index` once.
- 0.2.2 is the fail-closed safety floor and the current stable release. It does not understand `forbids.imported_paths` or Issue `implements.paths`; it refuses to review or build context for a repository that uses them (`PROJECT_TRUTH_INVALID`) instead of silently ignoring them.
- Opening a repository that uses 0.3-only Truth with 0.2.1 or older is not supported. Those versions can leave such a Decision or Issue out without a visible warning, and a review can pass a change a Decision forbids.
- To go back to 0.2.x completely, first remove `implements.paths` from Issues and supersede Decisions that use `imported_paths` with Decisions that do not.

## Machine contract changes since rc.3

- Issue schema: optional `implements.paths` (repository path patterns). Graph relation rules version 2: File IMPLEMENTS Issue edges.
- Review: optional `decisionAuthority { state, active, supersedes, supersededBy }` on claims whose subject is a Decision. `duo.review/1` is unchanged (additive field); Review Record format and IDs are unchanged.
- Context: `CONTEXT_POLICY_VERSION` 6. The packet format and seed match values are unchanged.
- CLI: `duoctl decision review-pending`. Its `--json` result has `status` (`confirmed`, `partial`, `cancelled`, `none`, `failed`) and `session`.
- Diagnostics: `DECISION_SESSION_CONFLICT`.
- MCP: unchanged, nine tools with the same input schemas. Decision lock digests are unchanged.

The package file, its size and hashes are listed in the GitHub prerelease `v0.3.0-rc.4`.
