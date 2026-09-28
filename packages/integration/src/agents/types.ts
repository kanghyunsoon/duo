/**
 * Agent integration (TASK-017): the contract between the installer core and the per-agent adapters.
 * The installer connects existing surfaces (duoctl, the duo-director MCP server) to a coding agent's
 * project configuration and bridge file. It holds no Project Direction logic.
 */
import type { Diagnostic } from "@duo-director/core";

export const AGENT_IDS = ["codex", "claude-code"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value);

/**
 * How the agent starts DUO. The configuration records command + argsPrefix, never a developer's local
 * source path: "path" is duoctl on PATH (the installed executable), "npx" the project-local launcher
 * (npx --no-install duoctl from node_modules/.bin). Future distributions add a kind, not an adapter.
 */
export interface DuoLauncher {
  readonly kind: "path" | "npx" | "custom";
  readonly command: string;
  readonly argsPrefix: readonly string[];
}

/** A stdio launch as the agent configuration records it. */
export interface McpLaunchEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The duo-director entry in the agent configuration.
 * not-configured: no entry. already-configured: exactly the planned entry. drifted: the DUO-managed
 * entry differs (DUO updates it). compatible-different-format: a DUO launch written differently
 * (JSON: updated with confirmation; TOML outside the managed block: left to the human).
 * conflict: another command under the name, or a file DUO cannot read or merge; never overwritten.
 */
export type McpEntryStatus = "not-configured" | "already-configured" | "drifted" | "compatible-different-format" | "conflict";

export type BridgeStatus = "absent" | "current" | "outdated" | "malformed";

export type IntegrationStatus = "not-configured" | "configured" | "drifted" | "conflict";

export type FileAction = "create" | "modify" | "delete" | "none" | "blocked";

export interface McpInspection {
  readonly status: McpEntryStatus;
  /** The current duo-director entry, when there is one and it can be read. */
  readonly current?: unknown;
  /** Inside the DUO-managed block (TOML) or a recognisable DUO launch (JSON). */
  readonly managed: boolean;
  readonly reason?: string;
}

export interface IntegrationConflict {
  readonly target: string;
  readonly reason: string;
}

export interface FileSnapshot {
  readonly path: string;
  /** sha256 of the file bytes, or null when the file does not exist. */
  readonly hash: string | null;
}

export interface AgentIntegrationPlan {
  readonly format: "duo.agent-integration-plan/1";
  readonly operation: "install" | "remove";
  readonly agent: AgentId;
  readonly repositoryRoot: string;
  readonly launcher: DuoLauncher;
  readonly mcp: {
    readonly target: string;
    readonly status: McpEntryStatus;
    readonly current?: unknown;
    readonly planned?: McpLaunchEntry & Readonly<Record<string, unknown>>;
    readonly action: FileAction;
  };
  readonly bridge: {
    readonly target: string;
    readonly status: BridgeStatus;
    readonly plannedBlock?: string;
    readonly action: FileAction;
  };
  readonly requirements: {
    readonly duoctlAvailable: boolean;
    /** Codex reads project .codex/config.toml only in a trusted project; DUO never changes trust. */
    readonly projectTrustRequired: boolean;
    /** Claude Code asks the user to approve project-scoped .mcp.json servers; DUO never approves. */
    readonly approvalRequired: boolean;
  };
  readonly willCreate: readonly string[];
  readonly willModify: readonly string[];
  readonly willDelete: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly IntegrationConflict[];
  readonly warnings: readonly string[];
  /** Errors that stop the plan (not initialized, launcher unavailable, conflicts). */
  readonly blockers: readonly Diagnostic[];
  /** No blocker: apply may run (after a human or --yes approves the listed mutations). */
  readonly applicable: boolean;
  /** Nothing to write. */
  readonly noop: boolean;
  /** File identities the plan was made from; apply refuses when they changed (AGENT_PLAN_STALE). */
  readonly files: readonly FileSnapshot[];
}

export interface AgentIntegrationState {
  readonly agent: AgentId;
  readonly status: IntegrationStatus;
  readonly mcp: { readonly target: string } & McpInspection;
  readonly bridge: { readonly target: string; readonly status: BridgeStatus };
}

export interface VerifyCheck {
  readonly name: "config-parse" | "server-entry" | "bridge-block" | "launcher" | "mcp-launch";
  readonly ok: boolean;
  readonly detail?: string;
}

export interface AgentIntegrationVerification {
  readonly format: "duo.agent-integration-verify/1";
  readonly agent: AgentId;
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
  /** From duo_get_status through the configured launch, when it ran. */
  readonly server?: { readonly name: string; readonly tools: readonly string[]; readonly index: string | null; readonly baseline: string | null };
  readonly nextActions: readonly string[];
}
