/**
 * Agent integration core (TASK-017): inspect → plan (write 0) → apply → verify, and the matching
 * removal. Agent specifics are in the adapters; this file only orders the steps, guards the writes
 * (core write kind "agent-integration", no symlinks), keeps human content and refuses stale plans.
 * It never runs git, never commits, never changes Codex trust or Claude Code approval, never runs
 * duoctl init, and never touches .duo-project Truth.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createDiagnostic, failure, guardWrite, PROJECT_FILE_NAME, stableJson, STATE_DIR_NAME, success, writeFileAtomic, type Diagnostic, type ParseResult, type WriteKind } from "@duo-director/core";
import { redactSecrets } from "@duo-director/director";
import { probeMcpLaunch } from "../mcp/probe.js";
import { TOOLS } from "../mcp/tools.js";
import { SERVER_NAME, isDuoLaunch, type AgentIntegrationAdapter } from "./adapter.js";
import { BRIDGE_MARKERS, bridgeLines, inspectBridge } from "./bridge.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { checkLauncher, currentHost, effectiveLauncherHost, launcherDisplay, NPX_LAUNCHER, PATH_LAUNCHER, type HostEnvironment } from "./launcher.js";
import { findBlock, removeBlock, upsertBlock } from "./managed-block.js";
import {
  AGENT_IDS, type AgentId, type AgentIntegrationPlan, type AgentIntegrationState, type AgentIntegrationVerification, type BridgeStatus, type DuoLauncher,
  type FileAction, type IntegrationConflict, type IntegrationStatus, type McpInspection, type VerifyCheck, type LauncherVersionMismatchWarning,
} from "./types.js";

const ADAPTERS: Readonly<Record<AgentId, AgentIntegrationAdapter>> = { codex: codexAdapter, "claude-code": claudeCodeAdapter };
export const agentAdapter = (agent: AgentId): AgentIntegrationAdapter => ADAPTERS[agent];

/** The duo-director MCP tools this build serves (sorted): what a verified launch must answer with. */
export const EXPECTED_MCP_TOOLS: readonly string[] = Object.keys(TOOLS).sort();

const BACKUP_DIR = `${STATE_DIR_NAME}/runtime/backup`;
const ownershipPath = (agent: AgentId) => `${STATE_DIR_NAME}/runtime/agent-integration/${agent}.json`;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/u;

interface ReadFile { readonly text?: string; readonly hash: string | null; readonly problem?: string }

function readTarget(root: string, rel: string, kind: WriteKind = "agent-integration"): ReadFile {
  const guarded = guardWrite(root, rel, kind);
  if (guarded.value === undefined) return { hash: null, problem: guarded.diagnostics.map((d) => d.message).join("; ") };
  const abs = guarded.value.absolute;
  let bytes: Buffer;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { hash: "not-a-file", problem: `${rel} is not a regular file` };
    bytes = fs.readFileSync(abs);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { hash: null } : { hash: null, problem: `Cannot read ${rel}` };
  }
  return { text: bytes.toString("utf8"), hash: sha256(bytes) };
}

interface TargetOwnership {
  readonly existedBefore: boolean;
  readonly preSha256: string | null;
  readonly backup: string | null;
  readonly postSha256: string;
}

interface OwnershipState extends ReadFile {
  readonly valid: boolean;
  readonly targets: Readonly<Record<string, TargetOwnership>>;
  readonly created: readonly string[];
}

function validBackupPath(agent: AgentId, target: string, backup: unknown): backup is string | null {
  if (backup === null) return true;
  if (typeof backup !== "string") return false;
  return backup.startsWith(`${BACKUP_DIR}/agent-${agent}-`) && backup.endsWith(`/${target}`) && !backup.includes("..") && !backup.includes("\\");
}

function validTargetOwnership(agent: AgentId, target: string, raw: unknown): raw is TargetOwnership {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const t = raw as Record<string, unknown>;
  if (typeof t.existedBefore !== "boolean" || typeof t.postSha256 !== "string" || !HEX64.test(t.postSha256)) return false;
  if (!validBackupPath(agent, target, t.backup)) return false;
  return t.existedBefore ? typeof t.preSha256 === "string" && HEX64.test(t.preSha256) : t.preSha256 === null && t.backup === null;
}

function formatOwnershipRecord(agent: AgentId, targets: Readonly<Record<string, TargetOwnership>>): string {
  const created = Object.entries(targets).filter(([, t]) => !t.existedBefore).map(([p]) => p);
  const body = { format: "duo.agent-file-ownership/1" as const, agent, created, targets };
  const digest = sha256(stableJson(body));
  return JSON.stringify({ ...body, digest }, null, 2) + "\n";
}

/**
 * H-94: Only a valid install-time record whose postSha256 matches the current file permits deleting
 * a file DUO created, or restoring exact original bytes from the first backup. Missing or invalid
 * records never authorize deletion; removal falls back to keeping the file with a warning.
 */
function readOwnership(root: string, adapter: AgentIntegrationAdapter): OwnershipState {
  const rel = ownershipPath(adapter.id);
  const file = readTarget(root, rel, "regenerable");
  if (file.problem !== undefined) return { ...file, valid: false, targets: {}, created: [] };
  if (file.text === undefined) return { ...file, valid: false, targets: {}, created: [] };
  try {
    const value = JSON.parse(file.text) as Record<string, unknown> | null;
    const allowed = [adapter.mcpTarget, adapter.bridgeTarget];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value.format === "duo.agent-file-ownership/1") {
      if (value.targets !== null && typeof value.targets === "object" && !Array.isArray(value.targets)) {
        const rawTargets = value.targets as Record<string, unknown>;
        const keys = Object.keys(rawTargets);
        const created = Array.isArray(value.created) ? value.created : keys.filter((k) => (rawTargets[k] as { existedBefore?: unknown } | null)?.existedBefore === false);
        const body = {
          format: "duo.agent-file-ownership/1" as const,
          agent: value.agent,
          created,
          targets: rawTargets,
        };
        if (
          value.agent === adapter.id
          && typeof value.digest === "string" && value.digest === sha256(stableJson(body))
          && keys.every((k) => allowed.includes(k) && validTargetOwnership(adapter.id, k, rawTargets[k]))
          && Array.isArray(created)
          && created.every((p) => typeof p === "string" && allowed.includes(p))
          && new Set(created).size === created.length
          && keys.filter((k) => !(rawTargets[k] as TargetOwnership).existedBefore).sort().join(",") === [...created].sort().join(",")
        ) {
          const targets = rawTargets as Readonly<Record<string, TargetOwnership>>;
          return { ...file, valid: true, targets, created: created as string[] };
        }
      }
    }
  } catch { /* Invalid records are treated as no ownership evidence (H-94 (5)-(7)). */ }
  return { ...file, valid: false, targets: {}, created: [], problem: `${rel}: invalid file ownership record` };
}

function hadDuoContent(target: string, text: string): boolean {
  for (const a of Object.values(ADAPTERS)) {
    if (a.mcpTarget === target) return a.remove(text, true) !== undefined;
    if (a.bridgeTarget === target) return removeBlock(text, BRIDGE_MARKERS) !== undefined;
  }
  return false;
}

function onlyDuoContent(target: string, text: string | undefined): boolean {
  if (text === undefined) return false;
  for (const a of Object.values(ADAPTERS)) {
    if (a.mcpTarget === target) return a.remove(text, false) === null;
    if (a.bridgeTarget === target) {
      const next = removeBlock(text, BRIDGE_MARKERS);
      return next !== undefined && next.trim() === "";
    }
  }
  return false;
}

interface RemovalDecision {
  readonly next: string | null | undefined;
  readonly reason?: string;
}

function decideTargetRemoval(
  root: string,
  target: string,
  current: ReadFile,
  ownership: OwnershipState,
  removeContent: (keepFile: boolean) => string | null | undefined,
): RemovalDecision {
  if (current.text === undefined || current.hash === null) return { next: undefined };
  const record = ownership.valid ? ownership.targets[target] : undefined;
  const unchangedSinceInstall = record !== undefined && record.postSha256 === current.hash;
  const canDelete = record !== undefined && !record.existedBefore && unchangedSinceInstall;
  const stripped = removeContent(!canDelete);
  if (stripped === undefined) return { next: undefined };
  if (canDelete && stripped === null) return { next: null };
  // H-94 (8): when a pre-existing file is unchanged since install and its original backup matches preSha256, restore exact bytes.
  if (record !== undefined && record.existedBefore && unchangedSinceInstall && record.backup !== null && record.preSha256 !== null) {
    const backup = readTarget(root, record.backup, "regenerable");
    if (backup.problem === undefined && backup.text !== undefined && backup.hash === record.preSha256 && !hadDuoContent(target, backup.text)) {
      const reason = backup.text !== stripped || removeContent(false) === null
        ? `keep ${target} (it existed before DUO)`
        : undefined;
      return { next: backup.text, ...(reason === undefined ? {} : { reason }) };
    }
  }
  const withKeep = stripped === null ? (removeContent(true) ?? "") : stripped;
  const wouldHaveDeleted = removeContent(false) === null;
  if (!wouldHaveDeleted) return { next: withKeep };
  const why = !ownership.valid
    ? (ownership.problem !== undefined ? "invalid install record" : "no install record")
    : record === undefined
      ? "no install record"
      : record.existedBefore
        ? "it existed before DUO"
        : "modified since DUO installed it";
  return { next: withKeep, reason: `keep ${target} (${why})` };
}

const initialized = (root: string) => fs.existsSync(path.join(root, STATE_DIR_NAME, PROJECT_FILE_NAME));

/** The launcher an existing DUO entry uses (so status and removal judge it on its own terms). */
export function launcherOf(entry: unknown): DuoLauncher | undefined {
  if (!isDuoLaunch(entry)) return undefined;
  const e = entry as { command: string; args: string[] };
  if (e.command === PATH_LAUNCHER.command && e.args[0] === "mcp") return PATH_LAUNCHER;
  if (e.command === NPX_LAUNCHER.command && e.args[0] === "--no-install" && e.args[1] === "duoctl") return NPX_LAUNCHER;
  const at = e.args.indexOf("mcp");
  return { kind: "custom", command: e.command, argsPrefix: e.args.slice(0, Math.max(0, at)) };
}

function aggregate(mcp: McpInspection, bridge: BridgeStatus, problem: boolean): IntegrationStatus {
  if (problem || mcp.status === "conflict" || bridge === "malformed") return "conflict";
  if (mcp.status === "already-configured" && bridge === "current") return "configured";
  if (mcp.status === "not-configured" && bridge === "absent") return "not-configured";
  return "drifted";
}

/** Read-only state of one agent's integration (not-configured, configured, drifted, conflict). */
export function inspectAgentIntegration(root: string, agent: AgentId, options: { readonly launcher?: DuoLauncher } = {}): AgentIntegrationState {
  const adapter = ADAPTERS[agent];
  const mcpFile = readTarget(root, adapter.mcpTarget);
  const bridgeFile = readTarget(root, adapter.bridgeTarget);
  const firstLook = adapter.inspect(mcpFile.text, adapter.plannedEntry(options.launcher ?? PATH_LAUNCHER));
  const launcher = options.launcher ?? launcherOf(firstLook.current) ?? PATH_LAUNCHER;
  const mcp = adapter.inspect(mcpFile.text, adapter.plannedEntry(launcher));
  const bridge = inspectBridge(bridgeFile.text, bridgeLines(launcherDisplay(launcher)));
  return {
    agent, status: aggregate(mcp, bridge, mcpFile.problem !== undefined || bridgeFile.problem !== undefined),
    mcp: { target: adapter.mcpTarget, ...mcp, ...(mcpFile.problem === undefined ? {} : { reason: mcpFile.problem }) },
    bridge: { target: adapter.bridgeTarget, status: bridgeFile.problem === undefined ? bridge : "malformed" },
  };
}

export function agentIntegrationStatus(root: string): AgentIntegrationState[] {
  return AGENT_IDS.map((a) => inspectAgentIntegration(root, a));
}

export interface PlanOptions {
  readonly launcher?: DuoLauncher;
  readonly host?: HostEnvironment;
  /**
   * duoctl setup (Jira S15P31A106-319): plan as if Project Truth already existed, because the same confirmed setup
   * creates it before this plan is applied. Only AGENT_NOT_INITIALIZED is skipped; conflicts and launcher problems still block.
   */
  readonly assumeInitialized?: boolean;
}

const fileAction = (before: string | undefined, next: string | null | undefined): FileAction =>
  next === undefined ? "none" : next === null ? "delete" : before === undefined ? "create" : next === before ? "none" : "modify";

function summarize(entries: readonly [string, FileAction][]) {
  return {
    willCreate: entries.filter(([, a]) => a === "create").map(([p]) => p),
    willModify: entries.filter(([, a]) => a === "modify").map(([p]) => p),
    willDelete: entries.filter(([, a]) => a === "delete").map(([p]) => p),
    unchanged: entries.filter(([, a]) => a === "none").map(([p]) => p),
  };
}

/** What install would do. Writes nothing. Always returns a plan; blockers say why it cannot apply. */
export function planAgentIntegration(root: string, agent: AgentId, options: PlanOptions = {}): AgentIntegrationPlan {
  const adapter = ADAPTERS[agent];
  const launcher = options.launcher ?? PATH_LAUNCHER;
  const blockers: Diagnostic[] = [];
  const conflicts: IntegrationConflict[] = [];
  const warnings: string[] = [];
  const ownership = readOwnership(root, adapter);
  if (options.assumeInitialized !== true && !initialized(root)) blockers.push(createDiagnostic("AGENT_NOT_INITIALIZED", `${root} is not a DUO project yet: run duoctl init first (install never initializes)`));
  const launch = checkLauncher(root, launcher, effectiveLauncherHost(launcher, options.host ?? currentHost()));
  blockers.push(...launch.diagnostics);
  warnings.push(...launch.warnings);

  const mcpFile = readTarget(root, adapter.mcpTarget);
  const bridgeFile = readTarget(root, adapter.bridgeTarget);
  const planned = adapter.plannedEntry(launcher);
  const inspection = adapter.inspect(mcpFile.text, planned);
  let mcpAction: FileAction = "none";
  if (mcpFile.problem !== undefined) {
    conflicts.push({ target: adapter.mcpTarget, reason: mcpFile.problem });
    mcpAction = "blocked";
  } else if (inspection.status === "conflict" || (inspection.status === "compatible-different-format" && !inspection.managed)) {
    conflicts.push({ target: adapter.mcpTarget, reason: inspection.reason ?? `${SERVER_NAME} is configured differently` });
    mcpAction = "blocked";
  } else if (inspection.status !== "already-configured") {
    const next = adapter.write(mcpFile.text, planned);
    if (next === undefined) {
      conflicts.push({ target: adapter.mcpTarget, reason: `the ${SERVER_NAME} entry cannot be merged into this file layout` });
      mcpAction = "blocked";
    } else {
      mcpAction = fileAction(mcpFile.text, next);
    }
  }

  const lines = bridgeLines(launcherDisplay(launcher));
  const bridgeStatus = bridgeFile.problem !== undefined ? "malformed" : inspectBridge(bridgeFile.text, lines);
  let bridgeAction: FileAction = "none";
  if (bridgeStatus === "malformed") {
    const found = bridgeFile.text === undefined ? undefined : findBlock(bridgeFile.text, BRIDGE_MARKERS);
    conflicts.push({ target: adapter.bridgeTarget, reason: bridgeFile.problem ?? `DUO bridge markers: ${found?.kind === "malformed" ? found.reason : "malformed"}` });
    bridgeAction = "blocked";
  } else if (bridgeStatus !== "current") {
    bridgeAction = bridgeFile.text === undefined ? "create" : "modify";
  }
  const hasMutations = mcpAction === "create" || mcpAction === "modify" || bridgeAction === "create" || bridgeAction === "modify";
  if (ownership.problem !== undefined && hasMutations) {
    if (symlinkOnOwnershipPath(root, ownershipPath(agent))) {
      conflicts.push({ target: ownershipPath(agent), reason: ownership.problem });
    } else {
      warnings.push(`${ownership.problem}; ownership will be recorded from current files.`);
    }
  }
  for (const c of conflicts) blockers.push(createDiagnostic("AGENT_INTEGRATION_CONFLICT", `${c.target}: ${c.reason}`));
  // #3(a): how to do the step outside DUO, from the agents' documentation (Codex config and security docs; Claude Code MCP docs, project scope).
  if (adapter.projectTrustRequired) warnings.push("Codex reads .codex/config.toml only in a trusted project. Trust this folder yourself when Codex asks on first launch, or set trust_level = \"trusted\" for it under [projects] in ~/.codex/config.toml (DUO does not change trust).");
  if (adapter.approvalRequired) warnings.push("Claude Code asks you to approve project MCP servers from .mcp.json. Run claude in this project, accept the workspace trust dialog and approve duo-director (DUO does not approve it).");

  const actions: [string, FileAction][] = [[adapter.mcpTarget, mcpAction], [adapter.bridgeTarget, bridgeAction]];
  return {
    format: "duo.agent-integration-plan/1", operation: "install", agent, repositoryRoot: root, launcher,
    mcp: { target: adapter.mcpTarget, status: inspection.status, ...(inspection.current === undefined ? {} : { current: inspection.current }), planned, action: mcpAction },
    bridge: { target: adapter.bridgeTarget, status: bridgeStatus, plannedBlock: lines.join("\n"), action: bridgeAction },
    requirements: { duoctlAvailable: launch.available, projectTrustRequired: adapter.projectTrustRequired, approvalRequired: adapter.approvalRequired },
    ...summarize(actions), conflicts, warnings, blockers,
    applicable: blockers.length === 0, noop: actions.every(([, a]) => a === "none"),
    files: [{ path: adapter.mcpTarget, hash: mcpFile.hash }, { path: adapter.bridgeTarget, hash: bridgeFile.hash }, { path: ownershipPath(agent), hash: ownership.hash }],
  };
}

function symlinkOnOwnershipPath(root: string, rel: string): boolean {
  const g = guardWrite(root, rel, "regenerable");
  return g.value === undefined;
}

/** What remove would do: the DUO MCP entry and the DUO bridge block only. Writes nothing. */
export function planAgentRemoval(root: string, agent: AgentId): AgentIntegrationPlan {
  const adapter = ADAPTERS[agent];
  const state = inspectAgentIntegration(root, agent);
  const launcher = launcherOf(state.mcp.current) ?? PATH_LAUNCHER;
  const conflicts: IntegrationConflict[] = [];
  const warnings: string[] = [];
  const ownership = readOwnership(root, adapter);
  const hasManaged = state.mcp.managed || state.bridge.status === "current" || state.bridge.status === "outdated";
  if (ownership.problem !== undefined && hasManaged) {
    warnings.push(`${ownership.problem}; removing only DUO's entry/block and keeping files.`);
  } else if (!ownership.valid && ownership.hash === null && hasManaged) {
    warnings.push("File ownership is unknown for this installation (no install record); empty files are kept after removing DUO content.");
  }
  const mcpFile = readTarget(root, adapter.mcpTarget);
  const bridgeFile = readTarget(root, adapter.bridgeTarget);
  let mcpAction: FileAction = "none";
  if (mcpFile.problem !== undefined) {
    conflicts.push({ target: adapter.mcpTarget, reason: mcpFile.problem });
    mcpAction = "blocked";
  } else if (mcpFile.text !== undefined && state.mcp.status === "conflict") {
    conflicts.push({ target: adapter.mcpTarget, reason: state.mcp.reason ?? `${adapter.mcpTarget} cannot be parsed safely; nothing is removed` });
    mcpAction = "blocked";
  } else if (mcpFile.text !== undefined) {
    const decision = decideTargetRemoval(root, adapter.mcpTarget, mcpFile, ownership, (keepFile) => adapter.remove(mcpFile.text as string, keepFile));
    mcpAction = fileAction(mcpFile.text, decision.next);
    if (decision.reason !== undefined) warnings.push(decision.reason);
    if (decision.next === undefined && state.mcp.status !== "not-configured") warnings.push(`${adapter.mcpTarget}: the ${SERVER_NAME} entry is not DUO-managed (${state.mcp.status}); it is left in place`);
  }
  let bridgeAction: FileAction = "none";
  if (bridgeFile.problem !== undefined || state.bridge.status === "malformed") {
    conflicts.push({ target: adapter.bridgeTarget, reason: bridgeFile.problem ?? "DUO bridge markers are malformed; nothing is removed" });
    bridgeAction = "blocked";
  } else if (bridgeFile.text !== undefined) {
    const decision = decideTargetRemoval(root, adapter.bridgeTarget, bridgeFile, ownership, (keepFile) => {
      const next = removeBlock(bridgeFile.text as string, BRIDGE_MARKERS);
      return next === undefined ? undefined : !keepFile && next.trim() === "" ? null : next;
    });
    bridgeAction = fileAction(bridgeFile.text, decision.next);
    if (decision.reason !== undefined) warnings.push(decision.reason);
  }
  const blockers = conflicts.map((c) => createDiagnostic("AGENT_INTEGRATION_CONFLICT", `${c.target}: ${c.reason}`));
  const actions: [string, FileAction][] = [[adapter.mcpTarget, mcpAction], [adapter.bridgeTarget, bridgeAction]];
  return {
    format: "duo.agent-integration-plan/1", operation: "remove", agent, repositoryRoot: root, launcher,
    mcp: { target: adapter.mcpTarget, status: state.mcp.status, ...(state.mcp.current === undefined ? {} : { current: state.mcp.current }), action: mcpAction },
    bridge: { target: adapter.bridgeTarget, status: state.bridge.status, action: bridgeAction },
    requirements: { duoctlAvailable: true, projectTrustRequired: adapter.projectTrustRequired, approvalRequired: adapter.approvalRequired },
    ...summarize(actions), conflicts, warnings, blockers,
    applicable: blockers.length === 0, noop: actions.every(([, a]) => a === "none"),
    files: [{ path: adapter.mcpTarget, hash: mcpFile.hash }, { path: adapter.bridgeTarget, hash: bridgeFile.hash }, { path: ownershipPath(agent), hash: ownership.hash }],
  };
}

export interface ApplyResult {
  readonly changed: readonly { readonly path: string; readonly action: "create" | "modify" | "delete" }[];
  readonly backups: readonly string[];
}

function nextContents(root: string, plan: AgentIntegrationPlan, ownership: OwnershipState): Map<string, string | null> {
  const adapter = ADAPTERS[plan.agent];
  const out = new Map<string, string | null>();
  const mcpFile = readTarget(root, adapter.mcpTarget);
  const bridgeFile = readTarget(root, adapter.bridgeTarget);
  if (plan.operation === "install") {
    const planned = adapter.plannedEntry(plan.launcher);
    if (plan.mcp.action === "create" || plan.mcp.action === "modify") out.set(adapter.mcpTarget, adapter.write(mcpFile.text, planned) ?? mcpFile.text ?? "");
    if (plan.bridge.action === "create" || plan.bridge.action === "modify") out.set(adapter.bridgeTarget, upsertBlock(bridgeFile.text, bridgeLines(launcherDisplay(plan.launcher)), BRIDGE_MARKERS));
  } else {
    if (mcpFile.text !== undefined && (plan.mcp.action === "modify" || plan.mcp.action === "delete")) {
      const decision = decideTargetRemoval(root, adapter.mcpTarget, mcpFile, ownership, (keepFile) => adapter.remove(mcpFile.text as string, keepFile));
      if (decision.next !== undefined) out.set(adapter.mcpTarget, decision.next);
    }
    if (bridgeFile.text !== undefined && (plan.bridge.action === "modify" || plan.bridge.action === "delete")) {
      const decision = decideTargetRemoval(root, adapter.bridgeTarget, bridgeFile, ownership, (keepFile) => {
        const next = removeBlock(bridgeFile.text as string, BRIDGE_MARKERS);
        return next === undefined ? undefined : !keepFile && next.trim() === "" ? null : next;
      });
      if (decision.next !== undefined) out.set(adapter.bridgeTarget, decision.next);
    }
  }
  return out;
}

function buildUpdatedOwnership(
  adapter: AgentIntegrationAdapter,
  ownership: OwnershipState,
  before: ReadonlyMap<string, ReadFile>,
  after: ReadonlyMap<string, string>,
  backupPaths: ReadonlyMap<string, string>,
): Record<string, TargetOwnership> {
  const out: Record<string, TargetOwnership> = {};
  for (const target of [adapter.mcpTarget, adapter.bridgeTarget]) {
    const prev = ownership.valid ? ownership.targets[target] : undefined;
    const pre = before.get(target);
    const postText = after.get(target) ?? pre?.text;
    if (postText === undefined) continue;
    const postSha256 = sha256(postText);
    // H-94 (11): Re-install and update keep the first ownership answer when a valid record exists.
    // Even if the user edited the file after install, a file that existed before DUO remains existedBefore: true.
    if (prev !== undefined) {
      if (prev.existedBefore) {
        out[target] = {
          existedBefore: true,
          preSha256: prev.preSha256,
          backup: prev.backup,
          postSha256,
        };
      } else if (pre?.hash !== null && pre?.hash !== undefined && (prev.postSha256 === pre.hash || onlyDuoContent(target, pre.text))) {
        out[target] = { existedBefore: false, preSha256: null, backup: null, postSha256 };
      } else if (pre?.hash !== null && pre?.hash !== undefined) {
        out[target] = {
          existedBefore: true,
          preSha256: pre.hash,
          backup: backupPaths.get(target) ?? null,
          postSha256,
        };
      } else {
        out[target] = { existedBefore: false, preSha256: null, backup: null, postSha256 };
      }
      continue;
    }
    const existedBefore = pre?.text !== undefined && pre.hash !== null;
    out[target] = {
      existedBefore,
      preSha256: existedBefore ? pre.hash : null,
      backup: existedBefore ? (backupPaths.get(target) ?? null) : null,
      postSha256,
    };
  }
  return out;
}

/**
 * Applies a plan made by planAgentIntegration / planAgentRemoval. Refuses a plan with blockers and a
 * plan whose files changed since (AGENT_PLAN_STALE). Existing files are backed up under
 * .duo-project/runtime/backup/ first; a failed write restores what was already written.
 */
export async function applyAgentIntegration(root: string, plan: AgentIntegrationPlan, options: { readonly clock?: () => Date } = {}): Promise<ParseResult<ApplyResult>> {
  if (!plan.applicable) return failure(plan.blockers.length > 0 ? plan.blockers : [createDiagnostic("AGENT_INTEGRATION_CONFLICT", "the plan cannot be applied")]);
  const recordPath = ownershipPath(plan.agent);
  for (const f of plan.files) {
    const current = readTarget(root, f.path, f.path === recordPath ? "regenerable" : "agent-integration");
    const currentProblem = f.path === recordPath ? symlinkOnOwnershipPath(root, recordPath) : current.problem !== undefined;
    if (currentProblem || current.hash !== f.hash) {
      return failure([createDiagnostic("AGENT_PLAN_STALE", `${f.path} changed after the plan was made; plan again`)]);
    }
  }
  if (plan.noop) return success({ changed: [], backups: [] });

  const adapter = ADAPTERS[plan.agent];
  const ownership = readOwnership(root, adapter);
  const beforeFiles = new Map<string, ReadFile>([
    [adapter.mcpTarget, readTarget(root, adapter.mcpTarget)],
    [adapter.bridgeTarget, readTarget(root, adapter.bridgeTarget)],
  ]);
  const next = nextContents(root, plan, ownership);
  for (const [rel, text] of next) {
    const action = fileAction(beforeFiles.get(rel)?.text, text);
    const plannedAction = rel === adapter.mcpTarget ? plan.mcp.action : plan.bridge.action;
    if (action !== plannedAction) {
      return failure([createDiagnostic("AGENT_PLAN_STALE", `${rel} no longer matches the planned ${plannedAction} action; plan again`)]);
    }
  }

  const originals = new Map<string, string | undefined>();
  for (const rel of next.keys()) originals.set(rel, beforeFiles.get(rel)?.text);
  const backups: string[] = [];
  const backupPaths = new Map<string, string>();
  if (initialized(root)) {
    const stamp = (options.clock?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    let dir = `${BACKUP_DIR}/agent-${plan.agent}-${stamp}`;
    if (fs.existsSync(path.join(root, dir))) dir = `${dir}-${randomUUID().slice(0, 8)}`;
    for (const [rel, text] of originals) {
      if (text === undefined) continue;
      const target = `${dir}/${rel}`;
      const g = guardWrite(root, target, "regenerable");
      if (g.value === undefined) return failure(g.diagnostics);
      await writeFileAtomic(g.value.absolute, text);
      backups.push(target);
      backupPaths.set(rel, target);
    }
  }
  const changed: { path: string; action: "create" | "modify" | "delete" }[] = [];
  const afterTexts = new Map<string, string>();
  try {
    for (const [rel, text] of next) {
      const expected = plan.files.find((f) => f.path === rel);
      const current = readTarget(root, rel);
      if (expected !== undefined && (current.problem !== undefined || current.hash !== expected.hash)) {
        throw Object.assign(new Error("stale"), { diagnostics: [createDiagnostic("AGENT_PLAN_STALE", `${rel} changed after the plan was made; plan again`)] });
      }
      const g = guardWrite(root, rel, "agent-integration");
      if (g.value === undefined) throw Object.assign(new Error("guard"), { diagnostics: g.diagnostics });
      if (text === null) {
        await fsp.rm(g.value.absolute, { force: true });
        changed.push({ path: rel, action: "delete" });
        const dir = path.dirname(g.value.absolute);
        if (dir !== root && fs.readdirSync(dir).length === 0) await fsp.rmdir(dir);
      } else {
        await writeFileAtomic(g.value.absolute, text);
        changed.push({ path: rel, action: originals.get(rel) === undefined ? "create" : "modify" });
        afterTexts.set(rel, text);
      }
    }
    if (initialized(root)) {
      const expectedRecord = plan.files.find((f) => f.path === recordPath);
      if (expectedRecord !== undefined && readTarget(root, recordPath, "regenerable").hash !== expectedRecord.hash) {
        throw Object.assign(new Error("stale"), { diagnostics: [createDiagnostic("AGENT_PLAN_STALE", `${recordPath} changed after the plan was made; plan again`)] });
      }
      const g = guardWrite(root, recordPath, "regenerable");
      if (g.value === undefined) throw Object.assign(new Error("guard"), { diagnostics: g.diagnostics });
      if (plan.operation === "install") {
        const updatedTargets = buildUpdatedOwnership(adapter, ownership, beforeFiles, afterTexts, backupPaths);
        await writeFileAtomic(g.value.absolute, formatOwnershipRecord(plan.agent, updatedTargets));
      } else if (ownership.hash !== null) {
        await fsp.rm(g.value.absolute, { force: true });
      }
    }
  } catch (error) {
    for (const c of changed) {
      const original = originals.get(c.path);
      const written = next.get(c.path);
      const current = readTarget(root, c.path);
      if (written === null ? current.hash !== null : current.text !== written) continue;
      const abs = path.join(root, c.path);
      if (original === undefined) await fsp.rm(abs, { force: true }).catch(() => undefined);
      else await writeFileAtomic(abs, original).catch(() => undefined);
    }
    const diagnostics = (error as { diagnostics?: Diagnostic[] }).diagnostics ?? [createDiagnostic("FILE_WRITE_ERROR", (error as Error).message)];
    return failure(diagnostics);
  }
  return success({ changed, backups });
}

export interface VerifyOptions {
  /** Running CLI version, supplied by the caller; omitted/empty means unknown. */
  readonly cliVersion?: string;
  readonly host?: HostEnvironment;
  /** Start the configured launch and call initialize, tools/list, duo_get_status (default true). */
  readonly launch?: boolean;
  readonly timeoutMs?: number;
  /** Call duo_get_status through the launch (default true). duoctl doctor turns it off: it inspects the index itself. */
  readonly callStatus?: boolean;
}

/** Checks the installed integration: the files parse, hold the planned entry and block, the launcher resolves, the server answers. */
export async function verifyAgentIntegration(root: string, agent: AgentId, options: VerifyOptions = {}): Promise<AgentIntegrationVerification> {
  const adapter = ADAPTERS[agent];
  const checks: VerifyCheck[] = [];
  const warnings: LauncherVersionMismatchWarning[] = [];
  const mcpText = readTarget(root, adapter.mcpTarget).text;
  const entry = mcpText === undefined ? undefined : adapter.readEntry(mcpText);
  const launcher = launcherOf(entry) ?? PATH_LAUNCHER;
  const host = effectiveLauncherHost(launcher, options.host ?? currentHost());
  const inspection = adapter.inspect(mcpText, adapter.plannedEntry(launcher));
  checks.push({ name: "config-parse", ok: mcpText !== undefined && !(inspection.status === "conflict" && inspection.current === undefined), ...(mcpText === undefined ? { detail: `${adapter.mcpTarget} is missing` } : inspection.reason === undefined ? {} : { detail: inspection.reason }) });
  checks.push({ name: "server-entry", ok: inspection.status === "already-configured", detail: inspection.status });
  const bridge = inspectBridge(readTarget(root, adapter.bridgeTarget).text, bridgeLines(launcherDisplay(launcher)));
  checks.push({ name: "bridge-block", ok: bridge === "current", detail: bridge });
  const launch = checkLauncher(root, launcher, host);
  checks.push({ name: "launcher", ok: launch.available, ...(launch.available ? {} : { detail: launch.diagnostics.map((d) => d.message).join("; ") }) });
  let server: AgentIntegrationVerification["server"];
  let version: string | undefined;
  if (options.launch !== false && entry !== undefined && launch.available) {
    const env = adapter.launchEnvironment(root);
    const probe = await probeMcpLaunch({
      command: entry.command, args: entry.args, cwd: env.cwd, env: { ...pathEnv(host), ...env.env },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.callStatus === false ? { callStatus: false } : {}),
    });
    if (probe.ok) {
      version = probe.serverVersion;
      if (options.cliVersion && version && options.cliVersion !== version && launch.resolved !== undefined) {
        warnings.push({
          code: "launcher-version-mismatch", cliVersion: options.cliVersion, serverVersion: version, resolved: launch.resolved,
          nextActions: [`Update the DUO installation at ${launch.resolved} to ${options.cliVersion}.`, `duoctl install ${agent} --launcher npx`],
        });
      }
      const status = probe.status as { index?: { status?: string } | null; baseline?: { status?: string } | null } | null;
      server = { name: probe.serverName, tools: probe.tools, index: status?.index?.status ?? null, baseline: status?.baseline?.status ?? null };
      // The expected tools come from this build's tool table (T26.1), not a hard-coded count.
      const toolsMatch = probe.tools.length === EXPECTED_MCP_TOOLS.length && probe.tools.every((t, i) => t === EXPECTED_MCP_TOOLS[i]);
      checks.push({ name: "mcp-launch", ok: probe.serverName === SERVER_NAME && toolsMatch, detail: `${probe.serverName} · ${probe.tools.length} tools` });
    } else {
      // The server's stderr is reduced to its last two lines and passed through the shared secret redaction (T26.1).
      checks.push({ name: "mcp-launch", ok: false, detail: redactSecrets(`${probe.error}${probe.stderr === "" ? "" : ` · ${probe.stderr.trim().split("\n").slice(-2).join(" | ")}`}`).text });
    }
  }
  const nextActions: string[] = [];
  if (!launch.available && launcher.kind === "path") nextActions.push(`duoctl install ${agent} --launcher npx`);
  if (server !== undefined && options.callStatus !== false && server.index !== "current") nextActions.push(`${launcherDisplay(launcher)} index`);
  if (adapter.projectTrustRequired) nextActions.push("Trust this project in Codex so it loads .codex/config.toml (the trust prompt on first launch, or trust_level = \"trusted\" in ~/.codex/config.toml); then /mcp in Codex lists duo-director.");
  if (adapter.approvalRequired) nextActions.push("Run claude in this project and approve the duo-director server; until then claude mcp get duo-director shows Pending approval.");
  const provenance = {
    kind: launcher.kind, command: launcher.command, argsPrefix: launcher.argsPrefix,
    ...(launch.resolved === undefined ? {} : { resolved: launch.resolved }), ...(launch.localBin === undefined ? {} : { localBin: launch.localBin }),
    ...(version === undefined ? {} : { version }),
  };
  return { format: "duo.agent-integration-verify/1", agent, ok: checks.every((c) => c.ok), checks, launcher: provenance, ...(warnings.length === 0 ? {} : { warnings }), ...(server === undefined ? {} : { server }), nextActions };
}

/** PATH (and PATHEXT on Windows) from the host, so the probe resolves the launcher like the agent would. */
function pathEnv(host: HostEnvironment): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(host.env)) if (v !== undefined && (k.toUpperCase() === "PATH" || k.toUpperCase() === "PATHEXT")) out[k.toUpperCase()] = v;
  return out;
}
