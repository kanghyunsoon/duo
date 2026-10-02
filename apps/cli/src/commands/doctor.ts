/**
 * duoctl doctor (T26.1): the shared doctor operation, rendered. Read-only: it never initializes,
 * indexes, installs, commits or calls an LLM, and writes no metric. Human lines come from the check
 * IDs and reason codes; the --json result is the duo.doctor/1 payload. Exit 0 unless a check is an
 * error (6, ACTION_REQUIRED): warnings, an agent that is not connected and a disabled LLM keep 0.
 */
import { LLMProviderPool, projectDoctor, type DoctorAction, type DoctorCheck, type DoctorPayload } from "@duo-director/integration";
import { t, type Locale, type MessageKey } from "../messages.js";
import { nodeVersionProblem } from "../node-version.js";
import { EXIT, type Outcome } from "../output.js";
import { NODE_ENGINE, VERSION } from "../version.js";
import type { Env } from "./shared.js";

const GROUPS = ["runtime", "git", "truth", "index", "analysis", "agents", "llm"] as const;
const AGENT_NAMES: Readonly<Record<string, string>> = { "agent.codex": "Codex", "agent.claude_code": "Claude Code" };

type Params = Record<string, string | number>;

function params(c: DoctorCheck): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(c.facts)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  const f = c.facts as Record<string, unknown>;
  if (Array.isArray(f.codes)) out.codes = (f.codes as string[]).join(", ");
  if (Array.isArray(f.failed)) out.failed = (f.failed as string[]).join(", ");
  if (Array.isArray(f.problems)) out.problems = (f.problems as { code: string; path?: string }[]).map((p) => (p.path === undefined ? p.code : p.code + " (" + p.path + ")")).join(", ");
  if (Array.isArray(f.conflicts)) out.paths = (f.conflicts as { path: string }[]).map((p) => p.path).join(", ");
  if (AGENT_NAMES[c.id] !== undefined) out.agent = AGENT_NAMES[c.id] as string;
  return out;
}

function checkLine(L: Locale, c: DoctorCheck): string {
  const p = params(c);
  if (c.id === "git.initial_commit" && c.reason === "present") p.branch = typeof c.facts.branch === "string" && c.facts.detached !== true ? "branch " + c.facts.branch : "detached HEAD";
  if (c.id === "analysis.coverage") return coverageLine(L, c);
  const key = (c.group === "agents" ? "doctor.agent." + c.reason : c.group === "llm" ? "doctor.llm." + c.reason : "doctor." + c.id + "." + c.reason) as MessageKey;
  return t(L, key, p);
}

function coverageLine(L: Locale, c: DoctorCheck): string {
  const f = c.facts as { fileOnly?: number; languages?: { language: string; level: string; files: number }[]; fileOnlyExtensions?: { extension: string }[] };
  const parts = (f.languages ?? []).map((l) => l.language + " " + l.level + " (" + l.files + ")");
  if ((f.fileOnly ?? 0) > 0) {
    const ext = (f.fileOnlyExtensions ?? []).map((e) => (e.extension === "" ? "(none)" : "." + e.extension)).join(", ");
    parts.push(t(L, "doctor.analysis.file-only", { files: f.fileOnly ?? 0, extensions: ext === "" ? "" : ": " + ext }));
  }
  return parts.length === 0 ? t(L, "doctor.analysis.none") : parts.join(" · ");
}

function actionLine(L: Locale, a: DoctorAction): string {
  return t(L, ("doctor.action." + a.id) as MessageKey, { ...(a.params ?? {}), command: a.commands[0] ?? "", commands: a.commands.join(" · ") });
}

export function renderDoctor(L: Locale, d: DoctorPayload): string[] {
  const status = (c: DoctorCheck) => t(L, ("doctor.status." + c.status) as MessageKey);
  const width = Math.max(...(["ok", "info", "warning", "error"] as const).map((s) => columns(t(L, ("doctor.status." + s) as MessageKey)))) + 2;
  const pad = (s: string) => s + " ".repeat(Math.max(1, width - columns(s)));
  const out = [t(L, "doctor.title", { overall: t(L, ("doctor.overall." + d.overall) as MessageKey) })];
  for (const g of GROUPS) {
    // Skipped checks are listed once at the end: they wait for an earlier step, they are not problems of their own.
    const checks = d.checks.filter((c) => c.group === g && c.status !== "skipped");
    if (checks.length === 0) continue;
    out.push("", t(L, ("doctor.group." + g) as MessageKey));
    for (const c of checks) {
      out.push("  " + pad(status(c)) + checkLine(L, c));
      const indent = "  " + " ".repeat(width);
      if (c.id === "analysis.coverage" && c.status === "info") out.push(indent + t(L, "doctor.analysis.legend"));
      if (c.group === "agents" && c.status === "ok" && typeof c.facts.humanStep === "string") out.push(indent + t(L, ("doctor.agent.human." + c.facts.humanStep) as MessageKey));
      for (const a of c.actions) out.push(indent + "→ " + actionLine(L, a));
    }
  }
  const skipped = d.checks.filter((c) => c.status === "skipped");
  if (skipped.length > 0) out.push("", t(L, "doctor.skipped", { checks: skipped.map((c) => t(L, ("doctor.check." + c.id) as MessageKey)).join(", ") }));
  out.push("", t(L, "doctor.next"));
  if (d.next.length === 0) out.push("  " + t(L, "doctor.next.none"));
  d.next.forEach((a, i) => out.push("  " + (i + 1) + ". " + actionLine(L, a)));
  return out;
}

/** Terminal columns of a label: Hangul and other wide characters take two. */
function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1;
  return n;
}

export async function doctorCommand(env: Env): Promise<Outcome> {
  const payload = await projectDoctor(env.root, {
    runtime: { duoctl: VERSION, node: process.version, engine: NODE_ENGINE, supported: nodeVersionProblem(process.version, NODE_ENGINE) === undefined },
    host: { env: env.io.env, platform: process.platform },
    llm: new LLMProviderPool(env.io.env),
  });
  return {
    command: "doctor", exitCode: payload.overall === "action-required" ? EXIT.ACTION_REQUIRED : EXIT.OK,
    result: payload, diagnostics: [], human: renderDoctor(env.locale, payload),
  };
}
