# Contributing to DUO

Thank you for helping. DUO is a small project with one maintainer and a small core team, so small and focused contributions are the easiest to review and merge. Team members also follow [docs/team/README.md](docs/team/README.md).

## Before you start

- Search the [existing issues](https://github.com/kanghyunsoon/duo/issues) first. For a bug fix or a feature, open an issue (or comment on one) before you write code so we can agree on the approach.
- Prefer small pull requests that solve one problem.
- Issues labeled `good first issue` are a good place to start. If you have not contributed before, [docs/community/START_HERE.md](docs/community/START_HERE.md) ([한국어](docs/community/START_HERE.ko.md)) walks through the fork, the branch from `next`, the checks and the pull request.
- Questions and ideas are welcome in [Discussions](https://github.com/kanghyunsoon/duo/discussions).
- **Do not report security vulnerabilities in public issues, discussions or pull requests.** Use GitHub Private Vulnerability Reporting as described in [SECURITY.md](SECURITY.md).

## How we work with contributors

- **Claim before you start.** Comment on the issue with what you plan to change. A maintainer assigns it to you so two people do not work on the same thing. If you stop, say so in the issue and it goes back to the pool. An assignment with no activity for two weeks may be released after a reminder.
- **Any schedule is fine.** There are no deadlines for contributors unless the issue says so.
- **Language.** Ask questions in Korean or English. Please write issue titles, pull request titles and descriptions, and code comments in English so every contributor can read the record. Do not worry about polished English.
- **AI tools are welcome.** You may use coding agents or AI assistants. You are responsible for the change: read it, understand it, run the checks yourself and answer review questions about it. Fill in the **AI assistance** line of the pull request template (none, partly or mostly).
- **Documentation-only changes** need at least `pnpm docs:validate` locally; CI still runs the full `pnpm verify`. Everything else is under [Pull requests](#pull-requests).
- **Review is a normal step.** "Changes requested" means the change is close, not rejected. Push fixes to the same branch and reply to each comment. For contributors outside the team, each CI run starts after a maintainer has read the change and approved the workflow run, including runs for new pushes.
- **No guaranteed merge.** A maintainer merges after a reviewer who is not the author approves and CI passes on Windows, Ubuntu and macOS. During a release freeze, approved pull requests may wait until the release is out.
- **Slow reply?** If nobody answers your issue or pull request within a week, leave one follow-up comment. Please do not open a duplicate.
- **Changes to sensitive files get a stricter review.** Pull requests that touch `.github/workflows/`, a `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `vitest*.config.ts`, `scripts/` (including release scripts), the CLI or the agent and MCP integration are reviewed line by line before merge, and for contributors outside the team before CI runs. Explain why such a change is needed. A dependency or install-script change without a clear reason will be declined.
- **How maintainers run your code.** Maintainers read a pull request before any of it runs. Outside code runs in GitHub-hosted CI or in a throwaway environment without credentials, never on a maintainer machine that holds npm, GitHub admin, SSH or API credentials. Green CI does not prove a change is safe, and automated scanners do not replace a person's review.
- **Bug or vulnerability?** A bug goes in a public issue with the bug template. Anything that could let someone read secrets, run code or bypass a Decision check goes through [SECURITY.md](SECURITY.md) privately.
- **Credit.** Your merged commits, reviews and issues are public GitHub history, and you may use them in a portfolio. Starring the repository is never required to contribute.

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
- Every pull request needs a review from someone other than its author and green CI on Windows, Ubuntu and macOS. A maintainer, or for changes outside the maintainer-only list the code owner of that area ([.github/CODEOWNERS](.github/CODEOWNERS)), merges; authors do not merge their own pull requests.

## DUO-specific rules

DUO checks code changes against decisions that people have made. A few rules keep that trustworthy:

- **Agents propose, people decide.** An agent may propose a Decision. Confirming, rejecting or superseding a Decision belongs to a person. Do not add paths that confirm Decisions automatically.
- **Do not weaken Project Truth to make a test pass.** If a rule, Decision or requirement in a test fixture seems wrong, raise it in the issue instead of editing it away.
- **Do not edit fixtures just to get a PASS.** If an expected verdict (PASS, WARN, ASK, BLOCK) changes, explain why in the pull request.
- **Discuss first** before changing the Project Truth file format, the Decision Lock, or who has authority over Decisions. Open an issue and agree on the change before writing code.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the license of this project.
