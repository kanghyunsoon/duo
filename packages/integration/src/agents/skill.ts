/**
 * Opt-in project skill (S15P31A106-358, #8): written only by `duoctl install <agent> --with-skill`.
 * Both agents list it (Codex from .agents/skills, Claude Code from .claude/skills); whether an agent
 * loads it during a task is not verified yet, so this text only says how to reach DUO's existing tools.
 * The whole file is DUO's: it follows H-94 ownership like the other targets and is never merged.
 */
export const SKILL_TEXT = [
  "---",
  "name: duo",
  "description: Reach DUO's project direction tools (the duo-director MCP server) before planning, implementing or reviewing code changes in this repository, including when the duo_* tools are deferred, nested or not listed yet, and use the duoctl CLI when they stay unavailable.",
  "---",
  "",
  "# Reach DUO",
  "",
  "1. Look for the tools of the `duo-director` MCP server: `duo_get_status`, `duo_get_context`, `duo_review_changes`, `duo_propose_decision` and the other `duo_*` tools.",
  "   - If your client defers MCP tools behind a tool search, search for `duo-director` or `duo_get_status` and load the tools by name.",
  "   - If your client nests MCP tools (for example under a code runner), look for the `duo-director` server's tools there.",
  "   - If they are not listed when the session starts, wait a few seconds and check again: the server can take a few seconds to start.",
  "2. Then follow the DUO block in `AGENTS.md` / `CLAUDE.md`: `duo_get_status`, `duo_get_context` for the task, and `duo_review_changes` after meaningful changes.",
  "3. If the tools stay unavailable, run `duoctl status`, `duoctl context \"<task>\"` and `duoctl review` in a shell instead. Without `duo_propose_decision`, do not edit `.duo-project/`: tell the human the proposal tool is unavailable in this session.",
  "",
].join("\n");

