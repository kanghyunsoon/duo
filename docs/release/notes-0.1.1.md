# DUO 0.1.1 release notes (draft)

Patch release on top of 0.1.0. No public format, command, option, exit code or Truth format changes: every `--json` envelope and payload, the MCP tools, the UI API and `.duo-project` files are the same as in 0.1.0 ([compatibility](compatibility.md)). Only human-readable CLI lines were added.

## CLI guidance

- **Improved first-run CLI guidance.** After a successful `duoctl init` the output now also names the next step to connect a coding agent: `duoctl install codex` or `duoctl install claude-code`.
- **Clear remediation for stale project indexes.** When `duoctl status` shows a stale, missing or incompatible index, it adds "Run duoctl index to refresh the project index." `status` still never indexes, and the stale decision is unchanged.
- **Clear error guidance for repositories without an initial commit.** `duoctl init` in a Git repository without any commit still stops with the same result and exit code (exit 1, `ADOPTION_HEAD_REQUIRED`; exit 6 with a dirty working tree). The output now says to create the first commit and run `duoctl init` again. The Truth files and index created by the first attempt are kept and reused. DUO does not commit or stage anything; support for repositories without a commit would be a separate feature decision.

Both `--locale en` and `--locale ko` have the new lines.

## Development and release reliability (not runtime features)

- **Hardened Windows UI E2E test reliability.** The release conformance test of the local UI occasionally failed on Windows CI with `ECONNRESET`: the test reused an idle keep-alive connection right when the UI server's 5 s idle timeout closed it, because the test blocks between requests while it runs the CLI. The test now opens a new connection per request and waits for the UI process to exit. The UI server is unchanged.
- **Added published-package verification tooling.** `pnpm release:verify-published` checks a version after it was published: registry metadata and integrity, a clean install into a temporary prefix, the installed `duoctl`, the Git tag and the GitHub Release. It never publishes and needs no npm credentials.

## Unchanged

Node.js `>=24.15.0`, runtime dependencies and the shrinkwrapped dependency tree, language support (any Git repository L0, TypeScript/JavaScript L2, Java/C#/C++/Python L1, other languages file-level L0), and the benchmark results in [performance-benchmark](../performance-benchmark.md).

