# Contributing to DUO

Thank you for helping. DUO is a small project with one maintainer and a small core team, so small and focused contributions are the easiest to review and merge. Team members also follow [docs/team/README.md](docs/team/README.md).

## Before you start

- Search the [existing issues](https://github.com/kanghyunsoon/duo/issues) first. For a bug fix or a feature, open an issue (or comment on one) before you write code so we can agree on the approach.
- Prefer small pull requests that solve one problem.
- Issues labeled `good first issue` are a good place to start.
- Questions and ideas are welcome in [Discussions](https://github.com/kanghyunsoon/duo/discussions).
- **Do not report security vulnerabilities in public issues, discussions or pull requests.** Use GitHub Private Vulnerability Reporting as described in [SECURITY.md](SECURITY.md).

## Development

You need Node.js 24 (`>=24.15.0`) and pnpm 11.

```bash
pnpm install
pnpm verify        # boundaries → lint → typecheck → build → test → docs:validate
pnpm duoctl --version
```

To run one test file while you work: `pnpm exec vitest run <path-to-test>`.

The code is a pnpm workspace:

| Path | What it contains |
|---|---|
| `apps/cli` | the `duoctl` command and the published npm package |
| `packages/core` | Project Truth schema and loader, Decisions, verdicts, shared models |
| `packages/analyzer` | file scanning and language analysis (Tree-sitter) |
| `packages/graph` | the project graph, incremental index and impact |
| `packages/director` | context compiler, review, Knowledge Gaps, the optional LLM provider |
| `packages/integration` | the MCP server, the Codex / Claude Code adapters, the local HTTP API |
| `packages/ui` | the local web UI (React) |

Package dependency directions are checked by `pnpm check:boundaries` and ESLint.

## Pull requests

- Solve one problem per pull request and link the issue (`Closes #123`).
- Add a regression test for a bug fix.
- Describe any user-visible change: CLI output, exit codes, MCP results, generated files.
- Keep backwards compatibility. If an output format, a schema or a stored file changes, say so in the pull request.
- Make sure `pnpm verify` passes.
- Every pull request needs a review from someone other than its author and green CI on Windows, Ubuntu and macOS. The maintainer merges; authors do not merge their own pull requests.

## DUO-specific rules

DUO checks code changes against decisions that people have made. A few rules keep that trustworthy:

- **Agents propose, people decide.** An agent may propose a Decision. Confirming, rejecting or superseding a Decision belongs to a person. Do not add paths that confirm Decisions automatically.
- **Do not weaken Project Truth to make a test pass.** If a rule, Decision or requirement in a test fixture seems wrong, raise it in the issue instead of editing it away.
- **Do not edit fixtures just to get a PASS.** If an expected verdict (PASS, WARN, ASK, BLOCK) changes, explain why in the pull request.
- **Discuss first** before changing the Project Truth file format, the Decision Lock, or who has authority over Decisions. Open an issue and agree on the change before writing code.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the license of this project.
