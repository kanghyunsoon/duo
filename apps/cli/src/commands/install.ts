/**
 * duoctl install (TASK-017): connects a coding agent to this DUO project.
 *
 *   duoctl install <codex|claude-code> [--launcher path|npx]   plan → confirm → apply → verify
 *   duoctl install status [agent]                              read-only
 *   duoctl install remove <agent>                              plan → confirm → apply
 *
 * The integration package plans and writes; the CLI shows the plan, asks (TTY) or requires --yes
 * (non-interactive), and renders. --yes approves the planned file changes only: conflicts, malformed
 * files, Codex trust and Claude Code approval are never overridden. Install never runs init, never
 * indexes and never commits.
 */
import {
  AGENT_IDS, agentIntegrationStatus, applyAgentIntegration, inspectAgentIntegration, isAgentId, launcherDisplay, NPX_LAUNCHER, PATH_LAUNCHER, planAgentIntegration,
  planAgentRemoval, verifyAgentIntegration, type AgentId, type AgentIntegrationPlan, type AgentIntegrationVerification,
} from "@duo-director/integration";
import { createDiagnostic } from "@duo-director/core";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, interactive, usage, type Env } from "./shared.js";

export interface InstallOptions {
  readonly launcher?: string;
}

const host = (env: Env) => ({ env: env.io.env, platform: process.platform });

function renderPlan(env: Env, plan: AgentIntegrationPlan): string[] {
  const L = env.locale;
  const out = [
    t(L, "install.plan", { operation: plan.operation, agent: plan.agent, create: plan.willCreate.length, modify: plan.willModify.length, delete: plan.willDelete.length, unchanged: plan.unchanged.length }),
    t(L, "install.mcp", { target: plan.mcp.target, status: plan.mcp.status, action: plan.mcp.action }),
    t(L, "install.bridge", { target: plan.bridge.target, status: plan.bridge.status, action: plan.bridge.action }),
  ];
  if (plan.operation === "install") out.push(t(L, "install.launcher", { command: launcherDisplay(plan.launcher), state: plan.requirements.duoctlAvailable ? "found" : "not found" }));
  for (const p of plan.willCreate) out.push(t(L, "install.file", { action: "create", path: p }));
  for (const p of plan.willModify) out.push(t(L, "install.file", { action: "modify", path: p }));
  for (const p of plan.willDelete) out.push(t(L, "install.file", { action: "delete", path: p }));
  for (const c of plan.conflicts) out.push(t(L, "install.conflict", { target: c.target, reason: c.reason }));
  for (const b of plan.blockers.filter((d) => d.code !== "AGENT_INTEGRATION_CONFLICT")) out.push(t(L, "install.blocker", { code: b.code, message: b.message }));
  for (const w of plan.warnings) out.push(t(L, "install.note", { text: w }));
  return out;
}

function renderVerify(env: Env, v: AgentIntegrationVerification): string[] {
  const L = env.locale;
  return [
    t(L, "install.verify", { result: v.ok ? "ok" : "failed" }),
    ...v.checks.map((c) => t(L, "install.check", { mark: c.ok ? "✓" : "✗", name: c.name, detail: c.detail === undefined ? "" : ` · ${c.detail}` })),
    ...v.nextActions.map((a) => t(L, "install.next", { action: a })),
  ];
}

async function confirmAndApply(env: Env, command: string, plan: AgentIntegrationPlan, human: string[]): Promise<{ outcome?: Outcome; applied?: unknown }> {
  const metric = (status: string) => ({ status, agent: plan.agent });
  if (!plan.applicable) {
    const notInit = plan.blockers.some((d) => d.code === "AGENT_NOT_INITIALIZED");
    return { outcome: failed(command, notInit ? EXIT.NOT_INITIALIZED : EXIT.ACTION_REQUIRED, plan.blockers, human, { plan }, metric(notInit ? "not-initialized" : "blocked")) };
  }
  if (plan.noop) return {};
  if (!env.yes) {
    if (!interactive(env)) {
      human.push(t(env.locale, "install.confirm-required"));
      return { outcome: { command, exitCode: EXIT.ACTION_REQUIRED, result: { plan, status: "confirmation-required" }, diagnostics: [], human, metric: metric("confirmation-required") } };
    }
    for (const line of human) env.io.err(line);
    human.length = 0;
    const answer = (await env.io.prompt(`${t(env.locale, "install.confirm")} `))?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      return { outcome: failed(command, EXIT.ERROR, [], [t(env.locale, "install.cancelled")], { plan, status: "cancelled" }, metric("cancelled")) };
    }
  }
  const applied = await applyAgentIntegration(env.root, plan, { clock: () => env.io.now() });
  if (applied.value === undefined) return { outcome: failed(command, EXIT.ERROR, applied.diagnostics, [...human, ...diagLines(applied.diagnostics)], { plan }, metric("failed")) };
  human.push(t(env.locale, "install.applied", { list: applied.value.changed.map((c) => `${c.action} ${c.path}`).join(", ") }));
  return { applied: applied.value };
}

export async function installCommand(env: Env, sub: string | undefined, arg: string | undefined, options: InstallOptions): Promise<Outcome> {
  const agents = AGENT_IDS.join("|");
  if (sub === undefined) return usage("install", `usage: duoctl install <${agents}> | status [agent] | remove <agent>`);
  if (sub === "status") {
    if (arg !== undefined && !isAgentId(arg)) return usage("install", `unknown agent '${arg}' (${agents})`);
    const states = arg === undefined ? agentIntegrationStatus(env.root) : [inspectAgentIntegration(env.root, arg)];
    const human = states.map((s) => t(env.locale, "install.status", { agent: s.agent, status: s.status, mcp: s.mcp.status, mcpTarget: s.mcp.target, bridge: s.bridge.status, bridgeTarget: s.bridge.target }));
    return { command: "install", exitCode: EXIT.OK, result: { format: "duo.agent-integration-status/1", agents: states }, diagnostics: [], human };
  }
  if (sub === "remove") {
    if (arg === undefined || !isAgentId(arg)) return usage("install", `usage: duoctl install remove <${agents}>`);
    const plan = planAgentRemoval(env.root, arg);
    const human = renderPlan(env, plan);
    const step = await confirmAndApply(env, "install", plan, human);
    if (step.outcome !== undefined) return step.outcome;
    if (plan.noop) human.push(t(env.locale, "install.unchanged"));
    return { command: "install", exitCode: EXIT.OK, result: { plan, ...(step.applied === undefined ? {} : { apply: step.applied }) }, diagnostics: [], human, metric: { status: plan.noop ? "unchanged" : "removed", agent: arg } };
  }
  if (!isAgentId(sub)) return usage("install", `unknown agent '${sub}' (${agents})`);
  if (arg !== undefined) return usage("install", `unexpected argument '${arg}'`);
  const agent: AgentId = sub;
  if (options.launcher !== undefined && options.launcher !== "path" && options.launcher !== "npx") return usage("install", "--launcher must be path (duoctl on PATH) or npx (project-local)");
  const launcher = options.launcher === "npx" ? NPX_LAUNCHER : PATH_LAUNCHER;
  const plan = planAgentIntegration(env.root, agent, { launcher, host: host(env) });
  const human = renderPlan(env, plan);
  const step = await confirmAndApply(env, "install", plan, human);
  if (step.outcome !== undefined) return step.outcome;
  if (plan.noop) human.push(t(env.locale, "install.unchanged"));
  const verify = await verifyAgentIntegration(env.root, agent, { host: host(env) });
  human.push(...renderVerify(env, verify));
  const status = !verify.ok ? "verify-failed" : plan.noop ? "unchanged" : "installed";
  return {
    command: "install", exitCode: verify.ok ? EXIT.OK : EXIT.ERROR,
    result: { plan, status, ...(step.applied === undefined ? {} : { apply: step.applied }), verify },
    diagnostics: verify.ok ? [] : verify.checks.filter((c) => !c.ok).map((c) => createDiagnostic("AGENT_VERIFY_FAILED", `${c.name}: ${c.detail ?? "failed"}`)),
    human, metric: { status, agent },
  };
}
