import type { DoctorAction, DoctorCheck, DoctorCheckId, DoctorPayload } from "@duo-director/integration";
import { describe, expect, it } from "vitest";
import { renderDoctor } from "./commands/doctor.js";

/**
 * Every reason code and action projectDoctor can return has wording in both locales (a missing message key
 * would throw while rendering). The facts carry every placeholder the wording uses.
 */
const REASONS: Readonly<Record<DoctorCheckId, readonly string[]>> = {
  "runtime.node": ["supported", "unsupported"],
  "git.repository": ["repository", "not-top-level", "not-a-repository", "git-unavailable"],
  "git.initial_commit": ["present", "unborn", "inspection-failed"],
  "git.working_tree": ["clean", "dirty", "dirty-before-adoption", "inspection-failed"],
  "truth.project": ["valid", "not-initialized", "partial", "conflict", "invalid"],
  "truth.baseline": ["current", "advanced", "missing", "diverged", "incompatible", "inspection-failed"],
  "index.freshness": ["current", "stale", "missing", "incompatible", "inspection-failed"],
  "analysis.coverage": ["coverage"],
  "agent.codex": ["not-configured", "verified", "drifted", "conflict", "launcher-unavailable", "mcp-launch-failed", "mcp-tools-mismatch", "verify-failed"],
  "agent.claude_code": ["verified"],
  "llm.configuration": ["disabled", "configured", "credential-missing", "model-missing", "base-url-unsupported", "base-url-env", "custom-headers-env"],
};
const ACTIONS: readonly DoctorAction[] = [
  "install-node", "install-git", "git-init", "git-first-commit", "use-top-level", "init", "init-repair", "fix-truth", "index",
  "install-agent", "connect-agent", "fix-agent-config", "fix-launcher", "set-llm-credential", "fix-llm-config",
].map((id) => ({ id: id as DoctorAction["id"], commands: ["duoctl x"], params: { engine: "e", topLevel: "t", path: "p", target: "t", agent: "a", launcher: "l", env: "E", reason: "r" } }));
const FACTS = {
  duoctl: "0", node: "v24", engine: ">=24", root: "/r", topLevel: "/t", codes: ["C"], branch: "main", head: "abc", staged: 0, unstaged: 1, untracked: 2, conflicted: 0,
  name: "n", requirements: 0, decisions: 0, constraints: 0, conflicts: [{ path: "p" }], problems: [{ code: "C", path: "p" }], detail: "d", files: 3, fullRebuildReason: "corrupt",
  structural: 1, fileOnly: 2, languages: [{ language: "typescript", level: "L2", files: 1 }], fileOnlyExtensions: [{ extension: "md" }], launcher: "duoctl", tools: 9, mcp: "drifted",
  bridge: "current", target: ".mcp.json", version: "0", expected: 9, actual: 8, failed: ["launcher"], humanStep: "codex-trust", provider: "openai-responses", model: "m", credentialEnv: "OPENAI_API_KEY",
};
const group = (id: DoctorCheckId) => (id.startsWith("agent.") ? "agents" : id.slice(0, id.indexOf("."))) as DoctorCheck["group"];

describe("duoctl doctor rendering (T26.1)", () => {
  for (const locale of ["en", "ko"] as const) {
    it(locale + ": every reason, status and action renders without a missing key or an unfilled placeholder", () => {
      for (const [id, reasons] of Object.entries(REASONS) as [DoctorCheckId, readonly string[]][]) {
        for (const reason of reasons) {
          const checks: DoctorCheck[] = [
            { id, group: group(id), status: "warning", reason, facts: FACTS, actions: ACTIONS },
            { id: "index.freshness", group: "index", status: "skipped", reason: "requirement", requires: "truth.project", facts: {}, actions: [] },
          ];
          for (const overall of ["ready", "warnings", "action-required"] as const) {
            const payload: DoctorPayload = { format: "duo.doctor/1", overall, checks, next: ACTIONS.slice(0, 3) };
            const lines = renderDoctor(locale, payload);
            expect(lines.join("\n"), id + " " + reason).not.toMatch(/\{\w+\}|undefined/u);
          }
        }
      }
    });
  }
});
