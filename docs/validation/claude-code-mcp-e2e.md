# Claude Code MCP integration, end to end (#31)

Status: phase A (no account usage) and phase B (a Claude Code login, [approved on #31](https://github.com/kanghyunsoon/duo/issues/31#issuecomment-6408945894)) ran on 2026-10-26 on Windows 11 with public DUO 0.3.4 and Claude Code 2.1.308. Every DUO step passed. A4b (a headless run waits for the approval) is FAIL because of Claude Code's behaviour; see finding 1 under [Findings](#findings). macOS, Linux, DUO 0.4.0-rc.1 and Codex are **NOT TESTED** here.

The question: when a person follows the README, does Claude Code start DUO's MCP server from the `.mcp.json` that `duoctl install claude-code` writes, list the 9 tools, and call them during a real task after the documented approval step? Does the `CLAUDE.md` bridge lead the agent to DUO, and does the CLI fallback work when the tools are missing?

## Environment

| Item | Value |
|---|---|
| OS, Node, npm | Windows 11, Node 24.18.0, npm 12.0.1 |
| DUO | Public `@duo-director/cli@0.3.4` (npm `latest`), shasum `c770c36a3c9ebc446d625d1f30ff63dadf43946a`. The issue names 0.3.3; 0.3.4 is 0.3.3 plus the MCP SDK and zod security patch (T135), and the maintainer accepted 0.3.4 on #31. |
| Claude Code | `@anthropic-ai/claude-code@2.1.308` (npm `stable`) |
| Isolation | npm prefix, cache and an empty `.npmrc` in a scratch folder. `CLAUDE_CONFIG_DIR` in the same folder. No `ANTHROPIC_*`, `CLAUDE_*` or `OPENAI_*` variables. |
| Account | Phase A: none (`"loggedIn": false`). Phase B: one claude.ai login made inside the isolated `CLAUDE_CONFIG_DIR` with `claude auth login`; no existing credentials were copied. Default model `claude-opus-5-5`. The account's claude.ai connectors were loaded as well. |
| Repository | A 5-file JavaScript order service. Two constraints recorded through `duoctl init --non-interactive --answers -`. Phase B used fresh copies set up the same way. |

## Procedure

Use an empty scratch folder outside other repositories, with no `CLAUDE.md` in a parent folder: Claude Code also reads `CLAUDE.md` files from parent folders.

### Setup (PowerShell)

```powershell
$W = "$env:TEMP\duo-31"
New-Item -ItemType Directory -Force "$W\claude-config" | Out-Null
New-Item -ItemType File -Force "$W\empty.npmrc" | Out-Null
$env:npm_config_prefix = "$W\prefix"; $env:npm_config_cache = "$W\npm-cache"; $env:npm_config_userconfig = "$W\empty.npmrc"
npm install -g @duo-director/cli@0.3.4 @anthropic-ai/claude-code@2.1.308
$env:PATH = "$W\prefix;$env:PATH"
Get-ChildItem Env: | Where-Object Name -match '^(ANTHROPIC|CLAUDE|OPENAI)' | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:CLAUDE_CONFIG_DIR = "$W\claude-config"
claude auth status    # phase A requires "loggedIn": false
```

For each repository: create a small project with a first commit, then follow the README: `duoctl init`, `duoctl install claude-code` (`--yes` without a terminal), `duoctl doctor`, and commit `.mcp.json`, `CLAUDE.md` and `.duo-project/`. Right after that commit the index is stale, which is where a person's first agent session starts.

### Phase A: no account usage

1. **A1 Install.** `duoctl --version` and `claude --version` print `duoctl 0.3.4` and `2.1.308 (Claude Code)`.
2. **A2 README steps.** As above, in the repository.
3. **A3 Before approval.** `claude mcp list` and `claude mcp get duo-director`.
4. **A4 Server start and tool list inside Claude Code.** `claude -p "Reply with OK." --output-format stream-json --verbose --max-turns 1`. The first event (`system/init`) lists `mcp_servers` and `tools`. Without a login the model call ends with `Not logged in`, and the result event reports cost 0 and 0 tokens.
5. **A5 One tool call without Claude Code.** Start the command and args from `.mcp.json` with `CLAUDE_PROJECT_DIR` set to the repository, then send `initialize`, `tools/list` and `tools/call duo_get_status` (client below).
6. **A6 CLI fallback named in the bridge.** `duoctl status`, `duoctl context "add a discount to an order"`, `duoctl review`.

```js
// mcp-check.cjs <repository>: plain JSON-RPC over stdio, no SDK and no LLM
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers["duo-director"];
const child = spawn(cfg.command, cfg.args, { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, shell: process.platform === "win32" });
let buf = "", id = 0; const waiting = new Map();
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { const m = JSON.parse(line); waiting.get(m.id)?.(m); } }
});
const send = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
(async () => {
  const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "duo-31-check", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await send("tools/list", {});
  const call = await send("tools/call", { name: "duo_get_status", arguments: {} });
  console.log(init.result.serverInfo, list.result.tools.length, call.result.content[0].text);
  child.kill();
})();
```

### Phase B: logged-in Claude Code

Log in once inside the isolated folder with `claude auth login`. Each model session runs with `--max-turns 10`; stop at the cap instead of retrying. Record the `usage` of every result event, and keep the account email and organisation out of the evidence.

1. **B1 Approval step (interactive, no prompt sent).** In the phase A repository: `claude mcp reset-project-choices`, then `claude`. After the first-run theme and security screens, accept the workspace trust dialog and choose "Use this MCP server" for `duo-director`. `/mcp` lists it; `/exit`; then `claude mcp get duo-director`.
2. **B2 First tool call during a normal task.** In a fresh repository right after the README commit:

   ```powershell
   claude -p "Add an optional percentage discount to createOrder. Keep money in integer cents and keep the tests passing." --output-format stream-json --verbose --max-turns 10 --permission-mode default --allowedTools mcp__duo-director Read Edit Write Glob Grep "Bash(node --test:*)" "Bash(npm test:*)" "Bash(duoctl:*)" "Bash(git status:*)" "Bash(git diff:*)"
   ```

   The prompt does not mention DUO. The allow list with `--permission-mode default` keeps every other tool, including the account's connectors, from running unattended.
3. **B3 CLI fallback.** The same command in another fresh repository, adding `--strict-mcp-config --mcp-config no-mcp.json` with `{ "mcpServers": {} }`, so DUO's MCP server is unavailable while `CLAUDE.md` stays.
4. **B4 Bridge effect.** From the B2 and B3 events: does the agent follow `CLAUDE.md`?

## Results

| Step | Result | Evidence |
|---|---|---|
| A1 Install from npm | PASS | `duoctl 0.3.4` (registry shasum matches), `2.1.308 (Claude Code)`. npm 12 skipped Claude Code's `postinstall` (`allow-scripts`); the CLI still ran. |
| A2 init, install claude-code, doctor | PASS | Install: `Verify: ok`, `mcp-launch · duo-director · 9 tools`. Doctor: `ready`, "Claude Code: connected, the MCP server starts (duoctl · 9 tools)". |
| A3 Before approval | PASS | `claude mcp get duo-director`: `Scope: Project config (shared via .mcp.json)`, `Status: Pending approval`, as the README says. |
| A4 Server start and tool list in Claude Code | PASS | `system/init`: `{"name":"duo-director","status":"connected","source":"project"}`; all 9 `mcp__duo-director__duo_*` tools are listed (32 tools in total without a login). Result `Not logged in`, cost 0, 0 tokens. |
| A4b Headless run waits for the approval | FAIL (Claude Code behaviour) | The A4 run connected `duo-director` and listed its 9 tools while `claude mcp get` reported `Pending approval`. See finding 1. The approval step is tested only interactively (B1). |
| A5 One tool call, plain MCP client | PASS | `initialize` 431 ms, server `duo-director 0.3.4`, protocol `2025-06-18`; `tools/list` 9 tools; `duo_get_status` returns text and structured content. |
| A6 CLI fallback commands | PASS | `duoctl status` exit 0. Right after the commit, `context` and `review` exit 6 with `INDEX_REQUIRED`; after `duoctl index` both exit 0 (`review`: `PASS`). |
| B1 Approval step in an interactive session | PASS | Trust dialog, then "New MCP server found in this project: duo-director" with three choices; the default is "Continue without using this MCP server". After "Use this MCP server", `/mcp` shows `duo-director` with 9 tools under Project MCPs, and `claude mcp get` changes from `Pending approval` to `Connected`. |
| B2 First DUO tool call during a task | PASS | The agent loaded the DUO tools through Claude Code's tool search, then called `duo_get_status` (its third tool call), ran `duoctl index` for the stale index, called `duo_get_context`, edited `src/orders.js` and the test, ran the tests and `duoctl index`, and called `duo_review_changes` (`PASS`). Tests: 3 pass. |
| B3 CLI fallback when the server is unavailable | PASS | With no MCP server, the agent searched for the DUO tools, waited 5 seconds, ran `duoctl status`, searched again, then ran `duoctl index` and `duoctl context` before editing, and `duoctl index` and `duoctl review` after the tests. |
| B4 Bridge leads the agent to DUO | PASS | In B2 and B3 the agent followed the bridge in order: status, index when stale, context before the change, index and review after it. It changed only `src/orders.js` and `test/orders.test.js`; `.duo-project/` was not modified. |
| macOS and Linux E2E | NOT TESTED | This run covered Windows 11 only. |
| DUO 0.4.0-rc.1 E2E | NOT TESTED | This run used public DUO 0.3.4 only. |
| Codex E2E | NOT TESTED | This run used Claude Code 2.1.308 only. |

## Usage

| Session | Input | Cache writes | Cache reads | Output | `num_turns` | Outcome |
|---|---:|---:|---:|---:|---:|---|
| B1 (interactive approval) | | | | | | No prompt sent |
| B2 | 18 | 28,189 | 273,250 | 2,797 | 14 | `success`, 37 s |
| B3 | 12 | 10,603 | 113,518 | 2,299 | 8 | `success`, 38 s |
| **Total** | **30** | **38,792** | **386,768** | **5,096** | | 2 model sessions |
| Estimate on #31 | at most about 1M input tokens in total, mostly cache reads | | | under 30k | | 2 to 3 sessions |

Total input, counting cache writes and reads, was 425,590 tokens, about 43% of the estimate; output was 17% of it. No session stopped at `--max-turns 10`: Claude Code counts `num_turns` differently from the cap, and both runs ended with `success`. Claude Code's list-price estimate was 0.49 USD; the login is a subscription, so this is not a charge.

## Findings

1. **Headless runs do not wait for the approval.** In 2.1.308, `claude -p` starts `duo-director` and exposes its 9 tools while `claude mcp get` still reports `Pending approval`. Adding `enabledMcpjsonServers` in `.claude/settings.local.json` changes neither result. The README sentence "Claude Code asks before it uses a server from `.mcp.json`" holds for interactive sessions. This is Claude Code behaviour, not a DUO defect; whether the README should mention headless runs is a question for the maintainer.
2. **The first session starts with a stale index.** Committing the generated files, as the README asks, moves `HEAD`, so `duoctl context` and `duoctl review` return `INDEX_REQUIRED` until `duoctl index` runs. This is tracked in [#4](https://github.com/kanghyunsoon/duo/issues/4). In B2 and B3 the agent ran `duoctl index` itself, as the bridge says.
3. **The DUO tools were deferred.** With the account's connectors loaded, Claude Code put MCP tools behind its tool search. In B2 the agent's first action loaded the `duo_*` tools by name before calling them; in B3 it searched for them, waited and searched again before it used the CLI. Both match the bridge lines for clients that defer tools and for a server that starts late ([#8](https://github.com/kanghyunsoon/duo/issues/8)).

No DUO defect was found.

## Evidence notes

Paths are replaced with `<scratch>`. The account email, organisation and connector names are left out. The raw logs stay outside the repository because they contain local paths.

```text
$ claude mcp get duo-director              (A3, before approval)
  Status: Pending approval (run 'claude' to approve)

$ claude -p "Reply with OK." --output-format stream-json --verbose --max-turns 1   (A4, not logged in)
init: claude_code_version=2.1.308 model=claude-opus-5-5 permissionMode=default
mcp_servers=[{"name":"duo-director","status":"connected","source":"project"}]
duo tools (9): duo_get_context, duo_get_decision, duo_get_requirement, duo_get_status, duo_impact,
  duo_propose_decision, duo_review_changes, duo_search_evidence, duo_trace
result: is_error=true cost_usd=0 input_tokens=0 output_tokens=0 text=Not logged in · Please run /login

$ node mcp-check.cjs <scratch>\repo                                                  (A5)
initialize ms=431 server={"name":"duo-director","version":"0.3.4"} protocol=2025-06-18
tools/list: 9 tools
duo_get_status: DUO status: index stale · baseline advanced · pending decisions 0 · llm disabled · constraints not checked: CON-001, CON-002

$ claude                                                                              (B1)
  New MCP server found in this project: duo-director
    Use this MCP server
    Use this and all future MCP servers in this project
  > Continue without using this MCP server
/mcp   Project MCPs (<scratch>\repo\.mcp.json)  duo-director  9 tools
$ claude mcp get duo-director
  Status: Connected

B2 tool calls: ToolSearch (select the duo_* tools) · Glob · duo_get_status · Read x3 · Bash "duoctl index" ·
  duo_get_context · Edit src/orders.js · Edit test/orders.test.js · Bash "npm test ... && duoctl index" ·
  duo_review_changes · Read .duo-project/intent/constraints.yaml
  result: success, review PASS, 3 tests pass

B3 tool calls (no MCP server): ToolSearch "duo" (none) · Bash "sleep 5; ... duoctl status" · ToolSearch (none) ·
  Bash "duoctl index && duoctl context ..." · Write src/orders.js · Edit test/orders.test.js ·
  Bash "npm test ... && duoctl index && duoctl review"
  result: success, review PASS, 3 tests pass
```
