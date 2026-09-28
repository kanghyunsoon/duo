# @duo-director/cli

**DUO — AI Project Direction Layer for Coding Agents.** `duoctl` keeps coding agents (Codex, Claude Code) aligned with a project's confirmed intent: it observes the Git repository, gives the agent only the context a task needs, and reviews changes against confirmed decisions with evidence. DUO does not write code.

Requires Node.js 24.15 or later. No native build, no install script, no network access at run time.

## Three steps, three different things

```sh
npm install -g @duo-director/cli     # 1. install the duoctl executable
cd your-git-repository
duoctl init                          # 2. initialize DUO in this repository (.duo-project/, first index, adoption baseline)
duoctl install codex                 # 3. connect a coding agent (or: duoctl install claude-code)
```

Step 3 shows the planned file changes first and asks before writing. Codex needs the project to be trusted; Claude Code asks you to approve the `duo-director` server. DUO never commits.

## Daily use

```sh
duoctl status
duoctl context "what you are about to do"
duoctl index            # after code changes
duoctl review
```

Agents use the `duo-director` MCP server (`duoctl mcp`) with nine tools. They can propose decisions; only a human confirms them (`duoctl decision`).

Project-local installation (`npm install -D @duo-director/cli`) works too: connect agents with `duoctl install <agent> --launcher npx`, which records `npx --no-install duoctl` and only works while the package is installed in the project.
