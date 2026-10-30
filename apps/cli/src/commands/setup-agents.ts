/**
 * Agent steps of duoctl setup (Jira S15P31A106-319, #3): connect Codex and Claude Code inside the one setup flow
 * with the services duoctl install uses.
 *
 *   plan()   planAgentIntegration, read-only; assumeInitialized while this setup still has to create Project Truth,
 *            so conflicts and launcher problems block before the confirmation
 *   apply()  applyAgentIntegration (restores its own partial writes, H-94), then verifyAgentIntegration, which
 *            starts the configured MCP launch; a failed check is ok: false and setup stops with its resume command
 *
 * Codex project trust and Claude Code server approval come back as remaining steps; setup never performs them.
 * Setup connects only the agents named with --agent.
 */
import { createDiagnostic } from "@duo-director/core";
import { applyAgentIntegration, planAgentIntegration, verifyAgentIntegration, type AgentId, type AgentIntegrationPlan, type DuoLauncher } from "@duo-director/integration";
import { t } from "../messages.js";
import { VERSION } from "../version.js";
import { host, renderPlan, renderVerify } from "./install.js";
import type { SetupAgentStep } from "./setup.js";

const REMAINING = { codex: "setup.remaining.codex", "claude-code": "setup.remaining.claude-code" } as const;

export function agentSetupSteps(agents: readonly AgentId[], launcher: DuoLauncher): SetupAgentStep[] {
  return agents.map((agent) => ({
    id: agent,
    plan: ({ env, truthPlanned }) => {
      const plan = planAgentIntegration(env.root, agent, { launcher, host: host(env), assumeInitialized: truthPlanned });
      const lines = renderPlan(env, plan).map((line, i) => (i === 0 ? "  " + agent.padEnd(10) + " " : " ".repeat(13)) + line);
      return Promise.resolve({ willCreate: plan.willCreate, willModify: plan.willModify, blockers: plan.blockers, noop: plan.noop, lines, detail: plan });
    },
    apply: async ({ env }, planned) => {
      const applied = await applyAgentIntegration(env.root, planned.detail as AgentIntegrationPlan, { clock: () => env.io.now() });
      if (applied.value === undefined) return { ok: false, diagnostics: applied.diagnostics, lines: [], remaining: [] };
      const verify = await verifyAgentIntegration(env.root, agent, { host: host(env), cliVersion: VERSION });
      return {
        ok: verify.ok,
        diagnostics: verify.checks.filter((c) => !c.ok).map((c) => createDiagnostic("AGENT_VERIFY_FAILED", `${agent} ${c.name}: ${c.detail ?? "failed"}`)),
        // The trust and approval steps are the remaining lines below, localized; the verifier's English next actions are left out.
        lines: [t(env.locale, "setup.agent.applied", { agent, list: applied.value.changed.map((c) => `${c.action} ${c.path}`).join(", ") }), ...renderVerify(env, { ...verify, nextActions: [] })],
        remaining: [t(env.locale, REMAINING[agent])],
        detail: { apply: applied.value, verify },
      };
    },
  }));
}
