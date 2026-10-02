/**
 * duo doctor (CLI doctor, T26.1): one read-only pass over what a first run or a broken setup touches
 * (runtime, Git, Project Truth, adoption baseline, index freshness, analysis coverage, agent
 * integrations, the optional LLM). Each check has a stable ID, a status, a reason code, structured
 * facts and the exact next step. Doctor composes the existing operations (openGitProvider,
 * loadProjectTruth, inspectStateDirectory, getAdoptionBaselineStatus, inspectIndex, inspectAgentIntegration,
 * verifyAgentIntegration, the LLM factory) and adds no judgement of its own.
 *
 * Write 0: no init, index, install, config change, commit, cache cleanup, network or LLM request. The
 * index is inspected once. A check whose prerequisite is not met is skipped (requires), so one root
 * cause does not show as a cascade of errors. Optional parts (an agent that is not connected, the LLM
 * left disabled) are info, never warning or error.
 */
import path from "node:path";
import { findGitTopLevel, openGitProvider, type GitProvider } from "@duo-director/analyzer";
import { loadProjectTruth, type Diagnostic, type LoadedProject } from "@duo-director/core";
import { getAdoptionBaselineStatus, inspectStateDirectory, observeWorkingTree, redactSecrets } from "@duo-director/director";
import { inspectIndex, type IndexInspection } from "@duo-director/graph";
import { agentAdapter, EXPECTED_MCP_TOOLS, inspectAgentIntegration, launcherOf, verifyAgentIntegration } from "../agents/integration.js";
import { currentHost, launcherDisplay, type HostEnvironment } from "../agents/launcher.js";
import { AGENT_IDS, type AgentId } from "../agents/types.js";
import { llmPoolOf, OperationFailure, withGraphReader, withRegistry, type OperationOptions } from "./common.js";

export const DOCTOR_FORMAT = "duo.doctor/1";

/** Check IDs in report order. The order is the dependency order: a check only requires earlier ones. */
export const DOCTOR_CHECK_IDS = [
  "runtime.node", "git.repository", "git.initial_commit", "git.working_tree", "truth.project", "truth.baseline",
  "index.freshness", "analysis.coverage", "agent.codex", "agent.claude_code", "llm.configuration",
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/**
 * ok: works. info: a fact, or an optional part left off (not a problem). warning: DUO works and
 * something deserves attention. error: a core path does not work until the action is taken. skipped:
 * a prerequisite check is not ok. Deliberately not the Review verdicts (PASS, WARN, BLOCK, ASK).
 */
export type DoctorStatus = "ok" | "info" | "warning" | "error" | "skipped";
export type DoctorOverall = "ready" | "warnings" | "action-required";
export type DoctorGroup = "runtime" | "git" | "truth" | "index" | "analysis" | "agents" | "llm";

export type DoctorActionId =
  | "install-node" | "install-git" | "git-init" | "git-first-commit" | "use-top-level" | "init" | "init-repair" | "fix-truth" | "index"
  | "install-agent" | "connect-agent" | "fix-agent-config" | "fix-launcher" | "set-llm-credential" | "fix-llm-config";

/** One next step. commands: the exact commands to run (empty for a manual step); params: values the wording needs. */
export interface DoctorAction {
  readonly id: DoctorActionId;
  readonly commands: readonly string[];
  readonly params?: Readonly<Record<string, string>>;
}

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly group: DoctorGroup;
  readonly status: DoctorStatus;
  /** Stable reason code of this check (for example stale, not-configured); "requirement" when skipped. */
  readonly reason: string;
  /** skipped: the prerequisite check that is not ok. */
  readonly requires?: DoctorCheckId;
  /** Structured, secret-free facts behind the reason. */
  readonly facts: Readonly<Record<string, unknown>>;
  readonly actions: readonly DoctorAction[];
}

export interface DoctorPayload {
  readonly format: typeof DOCTOR_FORMAT;
  readonly overall: DoctorOverall;
  readonly checks: readonly DoctorCheck[];
  /** At most three actions in dependency order: what to do first. Optional LLM steps are never here. */
  readonly next: readonly DoctorAction[];
}

/** The executable's own facts, given by the surface (the CLI knows its version and engines range). */
export interface DoctorRuntime {
  readonly duoctl: string;
  readonly node: string;
  readonly engine: string;
  readonly supported: boolean;
}

export interface DoctorOptions extends OperationOptions {
  readonly runtime: DoctorRuntime;
  /** PATH and platform the agent launch is checked with (default: this process). */
  readonly host?: HostEnvironment;
  readonly launchTimeoutMs?: number;
}

const NEXT_LIMIT = 3;
const LIST_LIMIT = 5;
const DETAIL_LIMIT = 300;

const groupOf = (id: DoctorCheckId): DoctorGroup => (id.startsWith("agent.") ? "agents" : (id.slice(0, id.indexOf(".")) as DoctorGroup));
const agentCheckId = (agent: AgentId): DoctorCheckId => `agent.${agent.replace("-", "_")}` as DoctorCheckId;
const command = (...parts: string[]) => ["duoctl", ...parts].join(" ");
/** A path as a shell argument: double quotes when it has spaces (no escaping, so Windows backslashes stay). */
const quoted = (p: string) => (/\s/u.test(p) ? `"${p}"` : p);
const codesOf = (d: readonly Diagnostic[]) => [...new Set(d.filter((x) => x.severity === "error").map((x) => x.code))].sort();
const short = (text: string) => (text.length > DETAIL_LIMIT ? text.slice(0, DETAIL_LIMIT - 1) + "…" : text);

/** Every string in facts and params goes through the shared redaction: agent files and server stderr are not DUO's text. */
function scrub<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) as T;
  return value;
}

type Result = Omit<DoctorCheck, "id" | "group">;

export async function projectDoctor(rootArg: string, options: DoctorOptions): Promise<DoctorPayload> {
  const root = path.resolve(rootArg);
  const host = options.host ?? currentHost();
  const results = new Map<DoctorCheckId, Result>();
  const set = (id: DoctorCheckId, status: DoctorStatus, reason: string, facts: Record<string, unknown> = {}, actions: DoctorAction[] = []) => {
    results.set(id, { status, reason, facts, actions });
  };
  const met = (id: DoctorCheckId) => { const s = results.get(id)?.status; return s === "ok" || s === "info" || s === "warning"; };
  /** Marks id skipped when a prerequisite is not met; true when the check may run. */
  const runs = (id: DoctorCheckId, ...requires: DoctorCheckId[]) => {
    const missing = requires.find((r) => !met(r));
    if (missing === undefined) return true;
    results.set(id, { status: "skipped", reason: "requirement", requires: missing, facts: {}, actions: [] });
    return false;
  };

  // Runtime: the executable's own facts. bin.js already refuses an unsupported Node before loading anything.
  const rt = options.runtime;
  set("runtime.node", rt.supported ? "ok" : "error", rt.supported ? "supported" : "unsupported", { duoctl: rt.duoctl, node: rt.node, engine: rt.engine },
    rt.supported ? [] : [{ id: "install-node", commands: [], params: { engine: rt.engine } }]);

  // Git: a work tree, its top level, the first commit.
  let git: GitProvider | undefined;
  const opened = await openGitProvider(root);
  if (opened.value !== undefined) {
    git = opened.value;
    set("git.repository", "ok", "repository", { root });
  } else {
    const codes = codesOf(opened.diagnostics);
    if (codes.includes("SCAN_ROOT_INVALID")) {
      const top = await findGitTopLevel(root);
      set("git.repository", "error", "not-top-level", { root, ...(top === undefined ? {} : { topLevel: top }) },
        top === undefined ? [] : [{ id: "use-top-level", commands: [command("doctor", "--root", quoted(top))], params: { topLevel: top } }]);
    } else if (codes.includes("GIT_COMMAND_FAILED")) {
      set("git.repository", "error", "git-unavailable", { root, codes }, [{ id: "install-git", commands: [] }]);
    } else {
      set("git.repository", "error", "not-a-repository", { root }, [{ id: "git-init", commands: [] }]);
    }
  }
  // Project Truth.
  let project: LoadedProject | undefined;
  if (runs("truth.project", "git.repository")) {
    const loaded = loadProjectTruth(root);
    if (loaded.value !== undefined) {
      project = loaded.value;
      const t = project.truth;
      set("truth.project", "ok", "valid", { name: t.config.name, requirements: t.requirements.length, decisions: t.decisions.length, constraints: t.constraints.length });
    } else if (loaded.diagnostics.some((d) => d.code === "PROJECT_FILE_MISSING")) {
      const state = inspectStateDirectory(root);
      if (state.state === "partial" && state.conflicts.length === 0) {
        set("truth.project", "error", "partial", { existing: state.existing.length }, [{ id: "init-repair", commands: [command("init", "--repair")] }]);
      } else if (state.state === "partial") {
        set("truth.project", "error", "conflict", { conflicts: state.conflicts.slice(0, LIST_LIMIT).map((c) => ({ path: c.path, reason: c.reason })) },
          [{ id: "fix-truth", commands: [], params: { path: state.conflicts[0]?.path ?? ".duo-project" } }]);
      } else {
        set("truth.project", "error", "not-initialized", {}, [{ id: "init", commands: [command("init")] }]);
      }
    } else {
      const problems = loaded.diagnostics.filter((d) => d.severity === "error").slice(0, LIST_LIMIT)
        .map((d) => ({ code: d.code, ...(d.source?.path === undefined ? {} : { path: d.source.path }) }));
      set("truth.project", "error", "invalid", { problems }, [{ id: "fix-truth", commands: [], params: { path: problems.find((p) => p.path !== undefined)?.path ?? ".duo-project/project.yaml" } }]);
    }
  }
  // Git state, the baseline, the index and the agent launches run side by side; the index is inspected once.
  const commitCheck = async (): Promise<void> => {
    if (!runs("git.initial_commit", "git.repository") || git === undefined) return;
    const state = await git.repositoryState();
    if (state.value === undefined) {
      set("git.initial_commit", "error", "inspection-failed", { codes: codesOf(state.diagnostics) });
    } else if (state.value.unborn) {
      // Without a first commit there is no baseline yet: after the commit, init records it.
      set("git.initial_commit", "error", "unborn", state.value.branch === undefined ? {} : { branch: state.value.branch },
        [{ id: "git-first-commit", commands: [] }, ...(project === undefined ? [] : [{ id: "init" as const, commands: [command("init")] }])]);
    } else {
      const s = state.value;
      set("git.initial_commit", "ok", "present", { ...(s.branch === undefined ? {} : { branch: s.branch }), detached: s.detached, head: (s.headOid ?? "").slice(0, 12), shallow: s.shallow });
    }
  };
  let adopted = false;
  const baselineCheck = async (): Promise<void> => {
    if (!runs("truth.baseline", "truth.project", "git.initial_commit")) return;
    const b = await getAdoptionBaselineStatus(root);
    const v = b.value;
    if (v === undefined) {
      set("truth.baseline", "error", "inspection-failed", { codes: codesOf(b.diagnostics) });
      return;
    }
    adopted = v.status !== "missing";
    const head = v.baseline?.git.headOid.slice(0, 12);
    const facts = { ...(head === undefined ? {} : { head }), ...(v.baseline === undefined ? {} : { dirtyAtAdoption: v.baseline.workingTree.dirty }), ...(v.reason === undefined ? {} : { detail: v.reason }) };
    if (v.status === "current" || v.status === "advanced") set("truth.baseline", "ok", v.status, facts);
    else if (v.status === "missing") set("truth.baseline", "warning", "missing", facts, [{ id: "init", commands: [command("init")] }]);
    else set("truth.baseline", "warning", v.status === "repository-diverged" ? "diverged" : "incompatible", facts);
  };
  const treeObservation = runs("git.working_tree", "git.repository") && git !== undefined ? observeWorkingTree(git, 0) : undefined;

  // The index is inspected once; the agent launches run next to it.
  const indexCheck = async (): Promise<IndexInspection | undefined> => {
    if (!runs("index.freshness", "truth.project")) return undefined;
    let inspected;
    try {
      inspected = await withRegistry(options.registry, (registry) => withGraphReader(root, (graph) => inspectIndex(root, { graph, registry })));
    } catch (error) {
      if (!(error instanceof OperationFailure)) throw error;
      set("index.freshness", "error", "inspection-failed", { codes: codesOf(error.diagnostics) });
      return undefined;
    }
    const i = inspected.value;
    if (i === undefined) {
      set("index.freshness", "error", "inspection-failed", { codes: codesOf(inspected.diagnostics) });
      return undefined;
    }
    const index: DoctorAction[] = [{ id: "index", commands: [command("index")] }];
    if (i.status === "current") set("index.freshness", "ok", "current");
    else if (i.status === "stale") set("index.freshness", "warning", "stale", { files: i.freshness.filter((f) => f.file !== "fresh").length, projectTruth: i.projectTruth.changed.length }, index);
    else set("index.freshness", "error", i.status, i.fullRebuildReason === undefined ? {} : { fullRebuildReason: i.fullRebuildReason }, index);
    return i;
  };

  const agentCheck = async (agent: AgentId): Promise<void> => {
    const id = agentCheckId(agent);
    if (!runs(id, "truth.project")) return;
    const state = inspectAgentIntegration(root, agent);
    const targets = [state.mcp.target, state.bridge.target];
    const current = launcherOf(state.mcp.current);
    const install = command("install", agent, ...(current?.kind === "npx" ? ["--launcher", "npx"] : []));
    if (state.status === "not-configured") {
      set(id, "info", "not-configured", { targets }, [{ id: "install-agent", commands: [command("install", agent)], params: { agent } }]);
      return;
    }
    // A conflict, or a DUO launch DUO does not rewrite (Codex TOML outside the managed block): a human edit.
    if (state.status === "conflict" || (state.mcp.status === "compatible-different-format" && !state.mcp.managed)) {
      const inMcp = state.mcp.status === "conflict" || state.mcp.status === "compatible-different-format" || state.mcp.reason !== undefined;
      const target = inMcp ? state.mcp.target : state.bridge.target;
      set(id, "error", "conflict", { target, detail: short(inMcp ? state.mcp.reason ?? state.mcp.status : "bridge " + state.bridge.status) },
        [{ id: "fix-agent-config", commands: [], params: { target, agent } }]);
      return;
    }
    if (state.status === "drifted") {
      set(id, "warning", "drifted", { targets, mcp: state.mcp.status, bridge: state.bridge.status }, [{ id: "install-agent", commands: [install], params: { agent } }]);
      return;
    }
    const adapter = agentAdapter(agent);
    const humanStep = adapter.projectTrustRequired ? "codex-trust" : adapter.approvalRequired ? "claude-approval" : undefined;
    const verify = await verifyAgentIntegration(root, agent, { host, callStatus: false, ...(options.launchTimeoutMs === undefined ? {} : { timeoutMs: options.launchTimeoutMs }) });
    const shown = launcherDisplay({ kind: verify.launcher.kind, command: verify.launcher.command, argsPrefix: verify.launcher.argsPrefix });
    const base = { targets, launcher: shown, ...(verify.launcher.version === undefined ? {} : { version: verify.launcher.version }) };
    if (verify.ok) {
      set(id, "ok", "verified", { ...base, tools: verify.server?.tools.length ?? 0, ...(humanStep === undefined ? {} : { humanStep }) });
      return;
    }
    const failed = (name: string) => verify.checks.find((c) => c.name === name && !c.ok);
    const launcher = failed("launcher");
    const launch = failed("mcp-launch");
    if (launcher !== undefined) {
      set(id, "error", "launcher-unavailable", { ...base, detail: short(launcher.detail ?? "") }, [{ id: "fix-launcher", commands: [], params: { launcher: shown, agent } }]);
    } else if (launch !== undefined && verify.server !== undefined) {
      const answered = new Set(verify.server.tools);
      set(id, "error", "mcp-tools-mismatch", {
        ...base, expected: EXPECTED_MCP_TOOLS.length, actual: verify.server.tools.length,
        missing: EXPECTED_MCP_TOOLS.filter((t) => !answered.has(t)), unexpected: verify.server.tools.filter((t) => !EXPECTED_MCP_TOOLS.includes(t)),
      }, [{ id: "install-agent", commands: [install], params: { agent } }]);
    } else if (launch !== undefined) {
      set(id, "error", "mcp-launch-failed", { ...base, detail: short(launch.detail ?? "") }, [{ id: "fix-launcher", commands: [], params: { launcher: shown, agent } }]);
    } else {
      set(id, "error", "verify-failed", { ...base, failed: verify.checks.filter((c) => !c.ok).map((c) => c.name) }, [{ id: "install-agent", commands: [install], params: { agent } }]);
    }
  };

  const [inspection, tree] = await Promise.all([indexCheck(), treeObservation, commitCheck().then(baselineCheck), ...AGENT_IDS.map(agentCheck)]);

  // Working tree (after the baseline: before adoption, init needs a policy for existing changes).
  if (tree !== undefined) {
    if (tree.value === undefined) set("git.working_tree", "warning", "inspection-failed", { codes: codesOf(tree.diagnostics) });
    else if (!tree.value.dirty) set("git.working_tree", "info", "clean");
    else set("git.working_tree", "info", adopted ? "dirty" : "dirty-before-adoption", { ...tree.value.counts });
  }

  // Coverage is a fact about the current files: the one inspection reports it whether or not the index is current.
  if (inspection !== undefined) {
    const c = inspection.coverage;
    set("analysis.coverage", "info", "coverage", {
      files: c.files.total, structural: c.files.structural, fileOnly: c.files.fileOnly,
      languages: c.languages.map((l) => ({ language: l.language, level: l.level, files: l.files })),
      fileOnlyExtensions: c.fileOnlyExtensions.slice(0, LIST_LIMIT),
    });
  } else {
    results.set("analysis.coverage", { status: "skipped", reason: "requirement", requires: results.get("index.freshness")?.status === "skipped" ? "truth.project" : "index.freshness", facts: {}, actions: [] });
  }

  // Optional LLM: local configuration and environment only; the credential value is never read out.
  if (runs("llm.configuration", "truth.project") && project !== undefined) {
    const config = project.truth.config.llm;
    const llm = llmPoolOf(options).forConfig(config);
    // openai-compatible (T27.1): the endpoint as its origin only (no path), the transport and output mode as configured.
    const endpoint = llm.endpoint === undefined ? {} : { endpoint: llm.endpoint.origin, transport: llm.endpoint.transport, structuredOutput: llm.endpoint.structuredOutput };
    const facts = { provider: llm.kind, ...(llm.model === undefined ? {} : { model: llm.model }), credentialEnv: config.apiKeyEnv, ...endpoint };
    if (llm.status === "disabled") set("llm.configuration", "info", "disabled", { provider: "none" });
    else if (llm.status === "configured") set("llm.configuration", "ok", "configured", facts);
    else {
      const reason = llm.reasonCode ?? "credential-missing";
      set("llm.configuration", "warning", reason, facts,
        [reason === "credential-missing" ? { id: "set-llm-credential", commands: [], params: { env: config.apiKeyEnv } } : { id: "fix-llm-config", commands: [], params: { reason } }]);
    }
  }

  const checks: DoctorCheck[] = DOCTOR_CHECK_IDS.map((id) => scrub({ id, group: groupOf(id), ...(results.get(id) ?? { status: "skipped" as const, reason: "requirement", facts: {}, actions: [] }) }));
  return { format: DOCTOR_FORMAT, overall: overallOf(checks), checks, next: nextActions(checks) };
}

function overallOf(checks: readonly DoctorCheck[]): DoctorOverall {
  if (checks.some((c) => c.status === "error")) return "action-required";
  return checks.some((c) => c.status === "warning") ? "warnings" : "ready";
}

/**
 * The first steps in check (dependency) order: Git, Truth, baseline, index, agents. init also indexes,
 * so it replaces an index step. When no agent is connected, one step names both supported agents (no
 * default choice). The optional LLM never adds a step.
 */
function nextActions(checks: readonly DoctorCheck[]): DoctorAction[] {
  const next: DoctorAction[] = [];
  const add = (a: DoctorAction) => { if (!next.some((n) => n.id === a.id && n.commands.join("\n") === a.commands.join("\n"))) next.push(a); };
  for (const c of checks) {
    if (c.group === "llm" || (c.status !== "error" && c.status !== "warning")) continue;
    for (const a of c.actions) add(a);
  }
  const steps = next.some((a) => a.id === "init") ? next.filter((a) => a.id !== "index") : next;
  const agents = checks.filter((c) => c.group === "agents");
  if (agents.length > 0 && agents.every((c) => c.status === "info" && c.reason === "not-configured")) {
    steps.push({ id: "connect-agent", commands: AGENT_IDS.map((a) => command("install", a)) });
  }
  return steps.slice(0, NEXT_LIMIT);
}

