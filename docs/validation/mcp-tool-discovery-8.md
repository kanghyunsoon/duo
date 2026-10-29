# MCP tool discovery on Codex and Claude Code (#8)

Status: **procedure only. No agent session has run.** The account-quota runs are not approved yet ([#8](https://github.com/kanghyunsoon/duo/issues/8#issuecomment-6484261673)); the target version and the session budget will be stated with the approval. The free signals below were measured on 2026-10-29 on Windows 11 / Node 24.18.0 without Codex, Claude Code or a login.

The question: when DUO is installed the documented way, how often does the agent's first DUO call go through DUO's MCP tools, how often does it fall back to the `duoctl` CLI, and how often does it use neither? T75 measured 0.3.2 with Codex only ([#8](https://github.com/kanghyunsoon/duo/issues/8#issuecomment-6157866448)). Since then 0.3.3 added the faster `duoctl mcp` start and the re-check line (#19), and 0.4 added the launcher check (#75, #81). Nothing has been measured with real agent sessions since.

This reuses Part 3 of [Value Validation 01](value-validation-01/README.md#8-part-3-실제-codex-mcp-발견률issue-8) and its script [discovery.mjs](../../bench/value-validation/discovery.mjs) for Codex. What this adds is Claude Code, a concurrent-start case, the per-run table the maintainer asked for, and a stop rule.

## Free signals since T75

| Signal | 0.3.2 (T75) | Now | Source |
|---|---|---|---|
| Tools listed by the server | 9 | 9 | `duoctl install` verify: `mcp-launch · duo-director · 9 tools` on `next` `0e684cd` |
| `initialize` time, one server alone | 1.19 s median (packed, before #19) | 0.3.3: 659 ms, 0.4.0-rc.1: 663 ms (median of 6, same machine and run) | `discovery.mjs --dry-run --versions 0.3.3,0.4.0-rc.1`. Process start to answer, Node start included. Numbers from different days and machines are not comparable; only the two values in one run are. |
| `initialize` time, 8 servers at once | 2.17 s median (before #19) | NOT MEASURED here | Covered by the no-LLM benchmark (#32) |
| Bridge text | No re-check line | One added line: "If the duo_* tools are not in your tool list when the session starts, wait a few seconds and check the list again before you fall back" | `git diff v0.3.2 next -- packages/integration/src/agents/bridge.ts`. Unchanged since 0.3.3 (`v0.3.3..next` is empty). `AGENTS.md` and `CLAUDE.md` get the same block. |
| Install output | Changed files only | Trust note (Codex) or approval note (Claude Code), then `Verify: ok` with the resolved launcher and the tool count, and the next step | `duoctl install codex --yes` and `duoctl install claude-code --yes` on `next` |
| Launcher missing on the agent's PATH | Install succeeds; the agent later cannot start the server and sees no `duo_*` tools | Install stops with `AGENT_LAUNCHER_UNAVAILABLE` and writes nothing (D1, #40) | Same, with no `duoctl` on PATH |

The last row matters for the measurement: a missing launcher used to look like "the agent did not find the tools". From 0.4 it fails at install, so a run that reaches the agent has a launcher that starts.

The configured entries on `next`:

- Codex, `.codex/config.toml`: `command = "duoctl"`, `args = ["mcp", "--root-from", "git-cwd", "--agent", "codex"]`.
- Claude Code, `.mcp.json`: `"type": "stdio"`, `"command": "duoctl"`, `"args": ["mcp", "--root-from", "env:CLAUDE_PROJECT_DIR", "--agent", "claude-code"]`.

## Procedure

Nothing in this section runs before the approval on #8.

### Isolation

As in [#31](claude-code-mcp-e2e.md): a scratch folder outside other repositories, an npm prefix and cache of its own, and no `OPENAI_*`, `ANTHROPIC_*` or `CLAUDE_*` variables. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` point into the scratch folder, and the runner logs in there once (`codex login`, `claude auth login`). No credential is copied. Evidence is sanitized: no account email, organisation or token.

### Repository and prompt

`discovery.mjs` prepares the repository: a small order service, `duoctl init`, `duoctl install codex` (and `claude-code` for Claude Code runs), a commit, then `duoctl index`. Every Claude Code run starts from a fresh copy. The prompt is fixed and asks for a plan with no file changes:

> Plan, but do not implement, a page that lists orders of 50 dollars or more, newest first. Do not change any files.

### Codex

```powershell
node bench/value-validation/discovery.mjs --out <dir> --versions <target> --runs <n> --timeout-min 10 --model <model> --i-understand-this-uses-codex
```

Read-only sandbox, `approval_policy="never"`, the repository trusted by command-line override, one model fixed with `-m`. Runs start one at a time.

### Claude Code

```powershell
claude -p "<prompt>" --output-format stream-json --verbose --max-turns 10 --permission-mode default --allowedTools mcp__duo-director Read Glob Grep "Bash(duoctl:*)"
```

Started in the repository copy, one at a time. The first event (`system/init`) shows whether `duo-director` is connected and which tools are listed.

### Classifying a run

- **MCP**: the first DUO action is a call to a `duo-director` tool. Codex: an `mcp_tool_call` item with `server` `duo-director`. Claude Code: a `tool_use` named `mcp__duo-director__duo_*`.
- **CLI**: no DUO MCP call, and at least one `duoctl` shell command.
- **Neither**: no DUO call of either kind.
- **Tool-name form**: `direct` (listed under its name), `deferred` (the agent first loaded or searched for it, for example Claude Code's `ToolSearch`), or `nested` (reached through a code runner, for example `tools.mcp__duo_director__…` in Codex code mode). `discovery.mjs` only counts `mcp_tool_call` items, so a nested call is classified from the run's `events.jsonl` by hand.
- **Time to first call**: from process start to the first DUO event.

### Gaps before a full run

- `discovery.mjs` runs Codex only and starts sessions one at a time. A Claude Code runner and a concurrent batch (4 sessions started together, the T74 load case) need a small script change, made in its own PR and only if the approval keeps those cases.
- `--versions` installs from the npm registry. A packed `next` as the target needs the tarball path instead.

## Stop rule and usage

1. No Codex or Claude Code session before the approval on #8, including the pilot.
2. **Pilot**: 3 Codex runs and 3 Claude Code runs on the approved target. Then stop and post the per-run usage on #8, with the projection below. Continue only after the maintainer confirms.
3. **During the runs**, stop at the first of these:
   - the approved budget is reached;
   - a run changes a file in its repository copy (`git status` not empty), which breaks the read-only premise;
   - two consecutive runs end on an infrastructure error (service error, network).
4. A run past 10 minutes is recorded as `timeout` and not repeated. An infrastructure failure may be rerun once under the same run ID, keeping the first log. No run is repeated because of its result.

How usage is read:

- **Codex**: per run, the sum of `turn.completed` usage (input, cached input, output), which `discovery.mjs` writes to `discovery.json`.
- **Claude Code**: per run, the result event's `usage` (input, cache writes, cache reads, output), `num_turns` and `total_cost_usd`. On a subscription login `total_cost_usd` is a list-price estimate, not a charge.
- **Account**: the usage shown for each account before and after the pilot.
- **Projection**: median per-run usage × remaining runs, per agent, posted with the pilot numbers.

## Results

NOT RUN. Filled in after approval.

| Run | Agent and version | Mode | DUO target | First DUO call | Tool-name form | First DUO tool | First call OK | Time to first DUO call | Wall | Usage | Settings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | alone / batch | | MCP / CLI / neither | direct / deferred / nested | | | | | | model, code mode, tool search |

| Agent | Runs | MCP | CLI | Neither | Timeouts |
|---|---:|---:|---:|---:|---:|
| Codex | | | | | |
| Claude Code | | | | | |

