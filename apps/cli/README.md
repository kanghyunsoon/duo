# @duo-director/cli

**DUO — AI Project Direction Layer for Coding Agents.** `duoctl` keeps coding agents (Codex, Claude Code) aligned with a project's confirmed intent: it observes the Git repository, gives the agent only the context a task needs, and reviews changes against confirmed decisions with evidence. DUO does not write code.

Requires Node.js 24.15 or later. No native build, no install script. LLM use is optional and off by default: indexing, context, review, the MCP server and the local UI work without an API key and without network access.

## Three steps, three different things

```sh
npm install -g @duo-director/cli     # 1. install the duoctl executable
cd your-git-repository
duoctl init                          # 2. initialize DUO in this repository (.duo-project/, first index, adoption baseline)
duoctl install codex                 # 3. connect a coding agent (or: duoctl install claude-code)
```

Step 3 shows the planned file changes first and asks before writing. Codex needs the project to be trusted; Claude Code asks you to approve the `duo-director` server. DUO never commits.

`duoctl init` works on an existing repository: it observes the repository, asks a few questions, writes a minimal Project Truth, builds the first index and records an adoption baseline, so problems that existed before DUO are told apart from new ones.

Language support: every Git repository gets file-level analysis (L0); TypeScript/JavaScript, Java, C#, C++ and Python get structural analysis (L1); TypeScript/JavaScript also get module and call resolution (L2). Other languages stay file-level.

On Windows the very first command after installation can take much longer than later ones (about 18 s vs 1.5 s on the reference PC): opening freshly installed JavaScript files for the first time. It happens once.

## Daily use

```sh
duoctl status
duoctl context "what you are about to do"
duoctl index            # after code changes
duoctl review
```

Agents use the `duo-director` MCP server (`duoctl mcp`) with nine tools. They can propose decisions; only a human confirms them (`duoctl decision`).

Project-local installation (`npm install -D @duo-director/cli`) works too: connect agents with `duoctl install <agent> --launcher npx`, which records `npx --no-install duoctl` and only works while the package is installed in the project.
