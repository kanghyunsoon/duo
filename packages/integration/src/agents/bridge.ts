/**
 * The Agent bridge (TASK-017): a short DUO-managed block in AGENTS.md (Codex) or CLAUDE.md (Claude
 * Code). It tells the agent when to use the DUO tools; the MCP server instructions carry only a few
 * principles. The block has no repository context and at most ten lines between the markers.
 */
import { findBlock, type Markers } from "./managed-block.js";
import type { BridgeStatus } from "./types.js";

export const BRIDGE_MARKERS: Markers = { begin: "<!-- duo-director:begin -->", end: "<!-- duo-director:end -->" };

/** The block lines, markers included. `duoctl` is the configured launcher as typed in a shell. */
export function bridgeLines(duoctl: string): string[] {
  const cmd = `\`${duoctl} index\``;
  return [
    BRIDGE_MARKERS.begin,
    "## DUO (project direction, duo-director MCP server)",
    `- Before substantial work: call duo_get_status; if the index is stale, run ${cmd}; then call duo_get_context for the task.`,
    "- Pending proposals are not confirmed project decisions.",
    `- After meaningful code changes: run ${cmd}, then call duo_review_changes.`,
    "- If the review returns ASK, show the human its question. Never bypass BLOCK by editing Project Truth (.duo-project/).",
    "- To change a decision, call duo_propose_decision. You cannot confirm or reject decisions; a human does.",
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
