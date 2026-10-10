# DUO 0.3.0-rc.5 release notes

Release candidate on the `next` development line, published to the npm dist-tag `next` (`npm install -g @duo-director/cli@next`). The stable release stays 0.2.2 on `latest`. This is a prerelease, not a stable release: 0.3.0 needs a separate decision. External Validation 01 keeps using exactly 0.2.1.

rc.5 contains everything in [0.3.0-rc.4](notes-0.3.0-rc.4.md) plus the changes below. It is a new build with its own version, commit and hashes; rc.3 and rc.4 stay published as they were.

## What changes for users

### Context path precision

- **Paths whose first directory starts with a dot** now resolve to that file. `.github/workflows/ci.yml` (also written `./.github/workflows/ci.yml`, `.github\workflows\ci.yml` or `.\.github\workflows\ci.yml`) is an exact file seed. Before, the leading dot was dropped, the path was searched as keywords, and a file with a similar name elsewhere could bring in a Decision that governs that other file. Dot directories deeper in a path (`src/.generated/file.ts`) already worked and are unchanged.
- **Root file names without a separator** can name the file (H-79). `package.json`, `README.md`, `tsconfig.base.json` (a dot inside the name) and `.gitignore`, `.editorconfig` (a leading dot) are exact file seeds when that file exists at the repository root and DUO indexes it. Matching is case-sensitive.
  - A leading-dot name is read as the file even when a code symbol has the same word (`.gitignore` is the file, `gitignore` the symbol).
  - A name with a dot inside keeps its symbol reading when a code symbol matches it: `Session.open` is still the method, and an ambiguous name still asks which one you mean. Write `./Session.open` for the file.
  - A name without a dot (`LICENSE`, `Dockerfile`, `config`) is still an ordinary word. Write `./LICENSE` for the file.
  - Secret files such as `.env*` are never indexed, so they never become context seeds.
- As for other exact paths and symbols, a word used as an exact file seed is not searched again as keywords; the other words of the task are.
- The context policy version is 8, so context packets cached by earlier versions are rebuilt.

### Validation reliability

These changes affect DUO's own test suite only; DUO's behavior is unchanged.

- The end-to-end tests that start DUO's MCP server through `duoctl install` and `duoctl doctor` run after the rest of the parallel suite. Under the start-up of the whole suite, one server start once took longer than the 30-second verification limit. The limit itself is unchanged and there is no retry: an install on a machine that busy still reports `verify-failed` honestly.
- New tests cover the MCP launch check itself: a late answer within the limit succeeds, a late or missing answer fails with the timeout, and the server process ends in both cases.
- The two session-planning tests that simulate whole confirm sessions on a copy of the Decisions have a longer test limit, for load on slow machines. `review-pending` itself is unchanged.

## Carried forward from rc.4

- `duoctl decision review-pending` reviews and confirms several proposals in one terminal session; only a person confirms, bound to the reviewed preview (MCP still has nine tools and no confirm tool).
- An Issue may declare `implements.paths`; a task naming only the Issue ID reaches the Decisions that govern those paths.
- Exact path and symbol words are not reused as keyword input; review claims about a Decision show its lifecycle (`decisionAuthority`).
- Invalid or partial Project Truth fails closed (`PROJECT_TRUTH_INVALID`). The bundled MCP SDK is 2.2.0 (GHSA-6qxp-vccf-f47h).

## Known limitations

- Root files whose name has no dot (`LICENSE`, `Dockerfile`, `Makefile`) need `./` in a task to be read as the file.
- Secret files (`.env*` and the other secret-file patterns) are not indexed and never appear in context.
- C239: a correct change can still get a review WARN from a missing-intent gap.
- `imported_paths`: an import through a barrel or re-export file is not seen as an import of the file behind it (false negatives). Java and C# imports are not checked.
- Agents read the structured provenance value `introduced` and may still describe it as "introduced by this change".
- Node.js `>=24.15.0`.
- Package size: about 24 MB packed and 114 MB unpacked, because the 67 runtime dependencies are bundled.

## Compatibility

- A project made by 0.2.1, 0.2.2 or an earlier 0.3.0 candidate opens in 0.3.0-rc.5 without migration and nothing is rewritten. From rc.4 nothing in the Project Truth, the index or the agent configuration changes; from 0.2.x the index is reported stale once (run `duoctl index` once).
- 0.2.2 remains the fail-closed safety floor and the current stable release: it refuses to review or build context for a repository that uses 0.3-only Truth (`forbids.imported_paths`, Issue `implements.paths`) with `PROJECT_TRUTH_INVALID`. rc.5 adds no Truth fields.
- Opening a repository that uses 0.3-only Truth with 0.2.1 or older is not supported: those versions can leave such a Decision or Issue out without a visible warning.

## Machine contract changes since rc.4

- Context: `CONTEXT_POLICY_VERSION` 6 → 8. The packet format and the seed `match` values are unchanged (root files and leading-dot paths use `path`).
- Unchanged: Truth schema, Graph schema and relation rules, `duo.review/1`, Review Records, Decision lock digests, MCP (nine tools, same input schemas), CLI commands and exit codes.

The package file, its size and hashes are listed in the GitHub prerelease `v0.3.0-rc.5`.
