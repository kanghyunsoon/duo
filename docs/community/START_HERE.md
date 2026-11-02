# Your first contribution to DUO

DUO is a local-first CLI and MCP server that reviews code changes against engineering Decisions a person confirmed. It is not a code generator, a security sandbox or an authenticated team permission system.

You do not need to understand every package to contribute. Documentation, reproducible bug reports, tests and small UX fixes all help. This page is for contributors outside the core team, who work from a fork without write access.

## 1. Pick a task

1. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) and look at the [open issues](https://github.com/kanghyunsoon/duo/issues). Issues labeled [`good first issue`](https://github.com/kanghyunsoon/duo/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and can be reviewed on their own. [`help wanted`](https://github.com/kanghyunsoon/duo/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are open to anyone but may need more context.
2. Comment on the issue with what you plan to change, so two people do not work on the same thing. A maintainer replies and assigns it to you.
3. No fitting issue? Start a thread in [Discussions](https://github.com/kanghyunsoon/duo/discussions).

## 2. Set up a fork

Git, Node.js 24.15 or later and pnpm 11.

```bash
# Fork kanghyunsoon/duo on GitHub first, then:
git clone https://github.com/YOUR-GITHUB-USERNAME/duo.git
cd duo
git remote add upstream https://github.com/kanghyunsoon/duo.git
git fetch upstream next
git switch -c docs/my-first-fix upstream/next
pnpm install
```

Work on a branch from `next`. `main` only receives releases.

## 3. Check your change

- Documentation only: `pnpm docs:validate`
- Code: the tests next to the code you changed (`pnpm exec vitest run <path-to-test>`), then `pnpm verify`

CI runs on Windows, Ubuntu and macOS. The Windows job is the slowest; see [#37](https://github.com/kanghyunsoon/duo/issues/37).

| Area | Code | Good first contributions |
|---|---|---|
| CLI | `apps/cli/` | Clearer help text and docs with real output |
| Decisions, Project Truth | `packages/core/` | Tests of existing behavior. Discuss before changing who may confirm Decisions |
| Analyzer, graph | `packages/analyzer/`, `packages/graph/` | Fixtures that reproduce a bug |
| Review, context | `packages/director/` | Reproductions of false positives or missed cases |
| MCP, agent setup | `packages/integration/` | Setup and troubleshooting docs |
| Local UI | `packages/ui/` | Small states with accessibility checks |

## 4. Open a pull request

```bash
git push origin docs/my-first-fix
```

Open a pull request from your fork to **`kanghyunsoon/duo` base `next`**. Fill in the template: the linked issue, what changed, how you tested it and any change users would see.

- Keep it to one problem.
- A reviewer who is not the author approves, CI passes on all three systems, then a maintainer merges. Push fixes to the same branch when reviewers ask for changes.
- Agents may propose Decisions; only a person confirms them. Never weaken a Decision or a test expectation to get a PASS.
- Never post credentials, tokens or private project files. Report vulnerabilities privately as described in [SECURITY.md](../../SECURITY.md).

## Working with us

- Claim before you start: comment on the issue with what you plan to change and wait until a maintainer assigns it to you, so two people do not work on the same thing.
- Ask questions in Korean or English. Write issue and pull request titles, descriptions and code comments in English.
- AI coding tools are fine. You are responsible for what you submit: understand it, run the checks and answer review questions. Fill in the AI assistance line of the pull request template.
- CI for contributors outside the team starts after a maintainer reads the change and approves the run, again after each new push. "Changes requested" is a normal step; push fixes to the same branch.
- Changes to sensitive files get a stricter review, for example workflows, `package.json`, the lockfile, `scripts/`, the CLI or the agent and MCP integration (full list in CONTRIBUTING). Say why the change is needed.
- If nobody replies within a week, leave one follow-up comment on the same issue or pull request. Do not open a duplicate issue.
- Merging is not guaranteed. While a release is frozen, approved pull requests may wait until it ships.
- Merged work is public GitHub history you can use in a portfolio. Starring the repository is not required.

The full policy is in [CONTRIBUTING.md](../../CONTRIBUTING.md#how-we-work-with-contributors).

## Try DUO first

The [0.3.3 walkthrough](../examples/decision-review-0.3.3.md) shows a real forbidden-import BLOCK and the PASS after the fix, and says which steps need a person.

A report that DUO did not help is as useful as a success. Tell us the cost, the confusing step, the error, the missed case or the false positive, with a reproduction that contains no private code.

[한국어](START_HERE.ko.md)

