/** duoctl status (T15): Truth, index freshness, adoption baseline, pending decisions. Writes nothing. */
import { getAdoptionBaselineStatus, llmProviderState } from "@duo-director/director";
import { listDecisionProposals } from "@duo-director/core";
import { inspectIndex } from "@duo-director/graph";
import { t } from "../messages.js";
import { EXIT, type Outcome } from "../output.js";
import { requireProject, withReader, withRegistry, type Env } from "./shared.js";

export async function statusCommand(env: Env): Promise<Outcome> {
  const project = requireProject(env, "status");
  if (project.value === undefined) return project.outcome as Outcome;
  const { truth } = project.value;
  const inspection = await withRegistry((registry) => withReader(env.root, (graph) => inspectIndex(env.root, { graph, registry })));
  const baseline = await getAdoptionBaselineStatus(env.root);
  const proposals = listDecisionProposals(truth).filter((p) => p.status === "pending");
  const i = inspection.value;
  const changes = i === undefined ? undefined : {
    files: i.freshness.filter((f) => f.file !== "fresh").length,
    analysisStale: i.freshness.filter((f) => f.analysis !== undefined && f.analysis !== "fresh").length,
    modulesToResolve: i.wouldRebuild.modules.length,
    callsMaybeRecomputed: i.wouldRebuild.predictedCalls.length,
    projectTruthChanged: i.projectTruth.changed.length,
  };
  const b = baseline.value;
  const result = {
    initialized: true,
    project: { name: truth.config.name, vision: truth.vision?.status ?? "missing", currentMilestone: truth.config.currentMilestone },
    truth: { requirements: truth.requirements.length, decisions: truth.decisions.length, constraints: truth.constraints.length, declaredGaps: truth.gaps.length },
    index: i === undefined ? null : { status: i.status, fullRebuildReason: i.fullRebuildReason ?? null, fullRebuildRequired: i.wouldRebuild.full, changes },
    baseline: b === undefined ? null : { status: b.status, ...(b.id === undefined ? {} : { id: b.id }), ...(b.reason === undefined ? {} : { reason: b.reason }), ...(b.baseline === undefined ? {} : { headOid: b.baseline.git.headOid, dirtyAtAdoption: b.baseline.workingTree.dirty, findings: b.baseline.findings.length }) },
    pendingDecisions: proposals.map((p) => ({ id: p.id, title: p.proposal.title, question: p.proposal.question })),
    llm: llmProviderState(truth.config.llm),
  };
  const L = env.locale;
  const human = [
    t(L, "status.project", { name: truth.config.name, goal: result.project.vision, milestone: truth.config.currentMilestone ?? "-" }),
    t(L, "status.truth", { requirements: result.truth.requirements, decisions: result.truth.decisions, constraints: result.truth.constraints, gaps: result.truth.declaredGaps }),
    t(L, "status.index", { status: i?.status ?? "unknown", reason: i?.fullRebuildReason === undefined ? "" : ` (full rebuild: ${i.fullRebuildReason})` }),
    ...(changes === undefined ? [] : [t(L, "status.changes", { files: changes.files, analysis: changes.analysisStale, modules: changes.modulesToResolve, calls: changes.callsMaybeRecomputed })]),
    t(L, "status.baseline", { status: b?.status ?? "unknown", detail: b?.baseline === undefined ? "" : ` · ${b.baseline.git.headOid.slice(0, 12)}${b.baseline.workingTree.dirty ? " · dirty at adoption" : ""} · ${b.baseline.findings.length} findings` }),
    t(L, "status.pending", { n: proposals.length }), ...proposals.map((p) => `  ${p.id}  ${p.proposal.title}`),
    t(L, "status.llm", { state: result.llm }),
  ];
  return { command: "status", exitCode: EXIT.OK, result, diagnostics: [...(inspection.diagnostics ?? []), ...baseline.diagnostics].filter((d) => d.severity === "error"), human };
}
