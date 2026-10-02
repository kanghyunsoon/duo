/**
 * Agent integration core (TASK-017): inspect → plan (write 0) → apply → verify, and the matching
 * removal. Agent specifics are in the adapters; this file only orders the steps, guards the writes
 * (core write kind "agent-integration", no symlinks), keeps human content and refuses stale plans.
 * It never runs git, never commits, never changes Codex trust or Claude Code approval, never runs
 * duoctl init, and never touches .duo-project Truth.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createDiagnostic, failure, guardWrite, PROJECT_FILE_NAME, STATE_DIR_NAME, success, writeFileAtomic, type Diagnostic, type ParseResult } from "@duo-director/core";
import { redactSecrets } from "@duo-director/director";
import { probeMcpLaunch } from "../mcp/probe.js";
import { TOOLS } from "../mcp/tools.js";
import { SERVER_NAME, isDuoLaunch, type AgentIntegrationAdapter } from "./adapter.js";
import { BRIDGE_MARKERS, bridgeLines, inspectBridge } from "./bridge.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { checkLauncher, currentHost, launcherDisplay, NPX_LAUNCHER, PATH_LAUNCHER, type HostEnvironment } from "./launcher.js";
import { findBlock, removeBlock, upsertBlock } from "./managed-block.js";
import {
  AGENT_IDS, type AgentId, type AgentIntegrationPlan, type AgentIntegrationState, type AgentIntegrationVerification, type BridgeStatus, type DuoLauncher,
  type FileAction, type IntegrationConflict, type IntegrationStatus, type McpInspection, type VerifyCheck,
} from "./types.js";

const ADAPTERS: Readonly<Record<AgentId, AgentIntegrationAdapter>> = { codex: codexAdapter, "claude-code": claudeCodeAdapter };
export const agentAdapter = (agent: AgentId): AgentIntegrationAdapter => ADAPTERS[agent];

/** The duo-director MCP tools this build serves (sorted): what a verified launch must answer with. */
export const EXPECTED_MCP_TOOLS: readonly string[] = Object.keys(TOOLS).sort();

const BACKUP_DIR = `${STATE_DIR_NAME}/runtime/backup`;

interface ReadFile { readonly text?: string; readonly hash: string | null; readonly problem?: string }

function readTarget(root: string, rel: string): ReadFile {
  const guarded = guardWrite(root, rel, "agent-integration");
  const abs = path.join(root, rel);
  let bytes: Buffer;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { hash: "not-a-file", problem: `${rel} is not a regular file` };
    bytes = fs.readFileSync(abs);
  } catch {
    return guarded.value === undefined ? { hash: null, problem: guarded.diagnostics.map((d) => d.message).join("; ") } : { hash: null };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (guarded.value === undefined) return { hash, problem: guarded.diagnostics.map((d) => d.message).join("; ") };
  return { text: bytes.toString("utf8"), hash };
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
  if (!initialized(root)) blockers.push(createDiagnostic("AGENT_NOT_INITIALIZED", `${root} is not a DUO project yet: run duoctl init first (install never initializes)`));
  const launch = checkLauncher(root, launcher, options.host ?? currentHost());
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
  for (const c of conflicts) blockers.push(createDiagnostic("AGENT_INTEGRATION_CONFLICT", `${c.target}: ${c.reason}`));
  if (adapter.projectTrustRequired) warnings.push("Codex reads .codex/config.toml only in a trusted project; trust it in Codex yourself (DUO does not change trust).");
  if (adapter.approvalRequired) warnings.push("Claude Code asks you to approve project MCP servers from .mcp.json; approve duo-director in Claude Code (DUO does not approve it).");

  const actions: [string, FileAction][] = [[adapter.mcpTarget, mcpAction], [adapter.bridgeTarget, bridgeAction]];
  return {
    format: "duo.agent-integration-plan/1", operation: "install", agent, repositoryRoot: root, launcher,
    mcp: { target: adapter.mcpTarget, status: inspection.status, ...(inspection.current === undefined ? {} : { current: inspection.current }), planned, action: mcpAction },
    bridge: { target: adapter.bridgeTarget, status: bridgeStatus, plannedBlock: lines.join("\n"), action: bridgeAction },
    requirements: { duoctlAvailable: launch.available, projectTrustRequired: adapter.projectTrustRequired, approvalRequired: adapter.approvalRequired },
    ...summarize(actions), conflicts, warnings, blockers,
    applicable: blockers.length === 0, noop: actions.every(([, a]) => a === "none"),
    files: [{ path: adapter.mcpTarget, hash: mcpFile.hash }, { path: adapter.bridgeTarget, hash: bridgeFile.hash }],
  };
}

/** What remove would do: the DUO MCP entry and the DUO bridge block only. Writes nothing. */
export function planAgentRemoval(root: string, agent: AgentId): AgentIntegrationPlan {
  const adapter = ADAPTERS[agent];
  const state = inspectAgentIntegration(root, agent);
  const launcher = launcherOf(state.mcp.current) ?? PATH_LAUNCHER;
  const conflicts: IntegrationConflict[] = [];
  const warnings: string[] = [];
  const mcpFile = readTarget(root, adapter.mcpTarget);
  const bridgeFile = readTarget(root, adapter.bridgeTarget);
  let mcpAction: FileAction = "none";
  if (mcpFile.problem !== undefined) {
    conflicts.push({ target: adapter.mcpTarget, reason: mcpFile.problem });
    mcpAction = "blocked";
  } else if (mcpFile.text !== undefined) {
    const next = adapter.remove(mcpFile.text);
    mcpAction = fileAction(mcpFile.text, next);
    if (next === undefined && state.mcp.status !== "not-configured") warnings.push(`${adapter.mcpTarget}: the ${SERVER_NAME} entry is not DUO-managed (${state.mcp.status}); it is left in place`);
  }
  let bridgeAction: FileAction = "none";
  if (bridgeFile.problem !== undefined || state.bridge.status === "malformed") {
    conflicts.push({ target: adapter.bridgeTarget, reason: bridgeFile.problem ?? "DUO bridge markers are malformed; nothing is removed" });
    bridgeAction = "blocked";
  } else if (bridgeFile.text !== undefined) {
    const next = removeBlock(bridgeFile.text, BRIDGE_MARKERS);
    bridgeAction = fileAction(bridgeFile.text, next === undefined ? undefined : next.trim() === "" ? null : next);
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
    files: [{ path: adapter.mcpTarget, hash: mcpFile.hash }, { path: adapter.bridgeTarget, hash: bridgeFile.hash }],
  };
}

export interface ApplyResult {
  readonly changed: readonly { readonly path: string; readonly action: "create" | "modify" | "delete" }[];
  readonly backups: readonly string[];
}

function nextContents(root: string, plan: AgentIntegrationPlan): Map<string, string | null> {
  const adapter = ADAPTERS[plan.agent];
  const out = new Map<string, string | null>();
  const mcpText = readTarget(root, adapter.mcpTarget).text;
  const bridgeText = readTarget(root, adapter.bridgeTarget).text;
  if (plan.operation === "install") {
    const planned = adapter.plannedEntry(plan.launcher);
    if (plan.mcp.action === "create" || plan.mcp.action === "modify") out.set(adapter.mcpTarget, adapter.write(mcpText, planned) ?? mcpText ?? "");
    if (plan.bridge.action === "create" || plan.bridge.action === "modify") out.set(adapter.bridgeTarget, upsertBlock(bridgeText, bridgeLines(launcherDisplay(plan.launcher)), BRIDGE_MARKERS));
  } else {
    if (mcpText !== undefined && (plan.mcp.action === "modify" || plan.mcp.action === "delete")) out.set(adapter.mcpTarget, adapter.remove(mcpText) ?? mcpText);
    if (bridgeText !== undefined && (plan.bridge.action === "modify" || plan.bridge.action === "delete")) {
      const next = removeBlock(bridgeText, BRIDGE_MARKERS) ?? bridgeText;
      out.set(adapter.bridgeTarget, next.trim() === "" ? null : next);
    }
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
  for (const f of plan.files) {
    if (readTarget(root, f.path).hash !== f.hash) return failure([createDiagnostic("AGENT_PLAN_STALE", `${f.path} changed after the plan was made; plan again`)]);
  }
  const next = nextContents(root, plan);
  const originals = new Map<string, string | undefined>();
  for (const rel of next.keys()) originals.set(rel, readTarget(root, rel).text);
  const backups: string[] = [];
  if (initialized(root)) {
    const stamp = (options.clock?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
    for (const [rel, text] of originals) {
      if (text === undefined) continue;
      const target = `${BACKUP_DIR}/agent-${plan.agent}-${stamp}/${rel}`;
      const g = guardWrite(root, target, "regenerable");
      if (g.value === undefined) return failure(g.diagnostics);
      await writeFileAtomic(g.value.absolute, text);
      backups.push(target);
    }
  }
  const changed: { path: string; action: "create" | "modify" | "delete" }[] = [];
  try {
    for (const [rel, text] of next) {
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
      }
    }
  } catch (error) {
    for (const c of changed) {
      const original = originals.get(c.path);
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
  const host = options.host ?? currentHost();
  const checks: VerifyCheck[] = [];
  const mcpText = readTarget(root, adapter.mcpTarget).text;
  const entry = mcpText === undefined ? undefined : adapter.readEntry(mcpText);
  const launcher = launcherOf(entry) ?? PATH_LAUNCHER;
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
  if (server !== undefined && options.callStatus !== false && server.index !== "current") nextActions.push(`${launcherDisplay(launcher)} index`);
  if (adapter.projectTrustRequired) nextActions.push("Trust this project in Codex so it loads .codex/config.toml.");
  if (adapter.approvalRequired) nextActions.push("Approve the duo-director server in Claude Code (it asks for project .mcp.json servers).");
  const provenance = {
    kind: launcher.kind, command: launcher.command, argsPrefix: launcher.argsPrefix,
    ...(launch.resolved === undefined ? {} : { resolved: launch.resolved }), ...(launch.localBin === undefined ? {} : { localBin: launch.localBin }),
    ...(version === undefined ? {} : { version }),
  };
  return { format: "duo.agent-integration-verify/1", agent, ok: checks.every((c) => c.ok), checks, launcher: provenance, ...(server === undefined ? {} : { server }), nextActions };
}

/** PATH (and PATHEXT on Windows) from the host, so the probe resolves the launcher like the agent would. */
function pathEnv(host: HostEnvironment): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(host.env)) if (v !== undefined && (k.toUpperCase() === "PATH" || k.toUpperCase() === "PATHEXT")) out[k] = v;
  return out;
}
