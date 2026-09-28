/** duoctl status (T15): the shared status operation, rendered. Writes nothing. */
import { projectStatus } from "@duo-director/integration";
import { t } from "../messages.js";
import { EXIT, type Outcome } from "../output.js";
import { operationFailure, type Env } from "./shared.js";

interface StatusPayload {
  project: { name: string; vision: string; currentMilestone: string | null };
  truth: { requirements: number; decisions: number; constraints: number; declaredGaps: number };
  index: { status: string; fullRebuildReason: string | null; changes: { files: number; analysisStale: number; modulesToResolve: number; callsMaybeRecomputed: number } } | null;
  baseline: { status: string; headOid?: string; dirtyAtAdoption?: boolean; findings?: number } | null;
  analysis: { languages: { language: string; files: number; level: string }[]; fileOnly: { files: number; extensions: { extension: string; files: number }[] } } | null;
  pendingDecisions: { id: string; title: string }[];
  llm: string;
}

export async function statusCommand(env: Env): Promise<Outcome> {
  const op = await projectStatus(env.root);
  if (op.kind !== "ok") return operationFailure(env, "status", op);
  const s = op.payload as unknown as StatusPayload;
  const L = env.locale;
  const c = s.index?.changes;
  const b = s.baseline;
  const a = s.analysis;
  const fileOnlyExts = a?.fileOnly.extensions.slice(0, 5).map((e) => (e.extension === "" ? "(none)" : `.${e.extension}`)).join(", ") ?? "";
  const analysis = a === null ? undefined : [
    ...a.languages.map((l) => `${l.language} ${l.level} (${l.files})`),
    ...(a.fileOnly.files === 0 ? [] : [`file-only L0 (${a.fileOnly.files}${fileOnlyExts === "" ? "" : `: ${fileOnlyExts}`})`]),
  ].join(" · ");
  const human = [
    t(L, "status.project", { name: s.project.name, goal: s.project.vision, milestone: s.project.currentMilestone ?? "-" }),
    t(L, "status.truth", { requirements: s.truth.requirements, decisions: s.truth.decisions, constraints: s.truth.constraints, gaps: s.truth.declaredGaps }),
    t(L, "status.index", { status: s.index?.status ?? "unknown", reason: s.index?.fullRebuildReason == null ? "" : ` (full rebuild: ${s.index.fullRebuildReason})` }),
    ...(c === undefined ? [] : [t(L, "status.changes", { files: c.files, analysis: c.analysisStale, modules: c.modulesToResolve, calls: c.callsMaybeRecomputed })]),
    ...(analysis === undefined || analysis === "" ? [] : [t(L, "status.analysis", { languages: analysis })]),
    t(L, "status.baseline", { status: b?.status ?? "unknown", detail: b?.headOid === undefined ? "" : ` · ${b.headOid.slice(0, 12)}${b.dirtyAtAdoption === true ? " · dirty at adoption" : ""} · ${b.findings ?? 0} findings` }),
    t(L, "status.pending", { n: s.pendingDecisions.length }), ...s.pendingDecisions.map((p) => `  ${p.id}  ${p.title}`),
    t(L, "status.llm", { state: s.llm }),
  ];
  return { command: "status", exitCode: EXIT.OK, result: op.payload, diagnostics: op.diagnostics, human };
}
