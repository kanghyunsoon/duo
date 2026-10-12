/**
 * The Agent bridge (TASK-017): a short DUO-managed block in AGENTS.md (Codex) or CLAUDE.md (Claude
 * Code). It tells the agent when to use the DUO tools; the MCP server instructions carry only a few
 * principles. The block has no repository context and at most ten lines between the markers. MCP
 * clients expose tools differently (some nest or defer them), so the block also gives the CLI fallback
 * and what to tell the human when the proposal tool is missing (#8).
 */
import { findBlock, type Markers } from "./managed-block.js";
import type { BridgeStatus } from "./types.js";

export const BRIDGE_MARKERS: Markers = { begin: "<!-- duo-director:begin -->", end: "<!-- duo-director:end -->" };

/** The block lines, markers included. `duoctl` is the configured launcher as typed in a shell. */
export function bridgeLines(duoctl: string): string[] {
  const cmd = `\`${duoctl} index\``;
  const cli = (sub: string) => `\`${duoctl} ${sub}\``;
  return [
    BRIDGE_MARKERS.begin,
    "## DUO (project direction, duo-director MCP server)",
    `- Before substantial work: call duo_get_status; if the index is stale, run ${cmd}; then call duo_get_context for the task.`,
    "- Pending proposals are not confirmed project decisions.",
    `- After meaningful code changes: run ${cmd}, then call duo_review_changes.`,
    "- If the review returns ASK, show the human its question. Never bypass BLOCK by editing Project Truth (.duo-project/).",
    "- To change a decision, call duo_propose_decision. You cannot confirm or reject decisions; a human does.",
    `- If the duo_* tools are not listed by name, look for the tools of the duo-director MCP server (some clients nest or defer MCP tools). If they are unavailable, run ${cli("status")}, ${cli('context "<task>"')} and ${cli("review")} in a shell instead.`,
    "- If duo_propose_decision is unavailable, do not edit .duo-project/ yourself: tell the human \"DUO's decision proposal tool is unavailable in this client/session\" and ask them to request the proposal in a session where DUO's MCP tools are available.",
    BRIDGE_MARKERS.end,
  ];
}

export function inspectBridge(text: string | undefined, planned: readonly string[]): BridgeStatus {
  if (text === undefined) return "absent";
  const found = findBlock(text, BRIDGE_MARKERS);
  if (found.kind === "none") return "absent";
  if (found.kind === "malformed") return "malformed";
  return found.text.replace(/\r\n/gu, "\n") === planned.join("\n") ? "current" : "outdated";
}
