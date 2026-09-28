/** duo status (CLI status, MCP duo_get_status): write 0. */
import { getAdoptionBaselineStatus, llmProviderState } from "@duo-director/director";
import { listDecisionProposals } from "@duo-director/core";
import { inspectIndex } from "@duo-director/graph";
import { errorsOf, guarded, project, withGraphReader, withRegistry, type Operation, type OperationOptions, type Failure } from "./common.js";

export const STATUS_FORMAT = "duo.status/1";

export function projectStatus(root: string, options: OperationOptions = {}): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const { truth } = p.value;
    const inspection = await withRegistry(options.registry, (registry) => withGraphReader(root, (graph) => inspectIndex(root, { graph, registry })));
    const baseline = await getAdoptionBaselineStatus(root);
    const pending = listDecisionProposals(truth).filter((e) => e.status === "pending");
    const i = inspection.value;
    const b = baseline.value;
    return {
      kind: "ok", diagnostics: errorsOf([...inspection.diagnostics, ...baseline.diagnostics]),
      payload: {
        format: STATUS_FORMAT, initialized: true,
        project: { name: truth.config.name, vision: truth.vision?.status ?? "missing", currentMilestone: truth.config.currentMilestone },
        truth: { requirements: truth.requirements.length, decisions: truth.decisions.length, constraints: truth.constraints.length, declaredGaps: truth.gaps.length },
        index: i === undefined ? null : {
          status: i.status, fullRebuildReason: i.fullRebuildReason ?? null, fullRebuildRequired: i.wouldRebuild.full,
          changes: {
            files: i.freshness.filter((f) => f.file !== "fresh").length,
            analysisStale: i.freshness.filter((f) => f.analysis !== undefined && f.analysis !== "fresh").length,
            modulesToResolve: i.wouldRebuild.modules.length, callsMaybeRecomputed: i.wouldRebuild.predictedCalls.length,
            projectTruthChanged: i.projectTruth.changed.length,
          },
          wouldRebuild: { full: i.wouldRebuild.full, parse: i.wouldRebuild.parse.length, history: i.wouldRebuild.history, projectTruth: i.wouldRebuild.projectTruth },
        },
        // T18.0 (additive): how deep the current files are analyzed. Every file has L0; no score.
        analysis: i === undefined ? null : {
          analyzerRegistryDigest: i.coverage.analyzerRegistryDigest,
          files: i.coverage.files,
          languages: i.coverage.languages.map((l) => ({
            language: l.language, files: l.files, analyzer: l.analyzer, level: l.level,
            symbols: l.capabilities.symbols, tests: l.capabilities.tests, imports: l.capabilities.imports, calls: l.capabilities.calls, typeResolution: l.capabilities.typeResolution,
          })),
          fileOnly: { level: "L0", files: i.coverage.files.fileOnly, extensions: i.coverage.fileOnlyExtensions },
        },
        baseline: b === undefined ? null : {
          status: b.status, ...(b.id === undefined ? {} : { id: b.id }), ...(b.reason === undefined ? {} : { reason: b.reason }),
          ...(b.baseline === undefined ? {} : { headOid: b.baseline.git.headOid, dirtyAtAdoption: b.baseline.workingTree.dirty, findings: b.baseline.findings.length }),
        },
        pendingDecisions: pending.map((e) => ({ id: e.id, title: e.proposal.title, question: e.proposal.question, answer: e.proposal.answer })),
        llm: llmProviderState(truth.config.llm),
      },
    };
  });
}
