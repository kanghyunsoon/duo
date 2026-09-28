/** duoctl index (T15): the explicit write command of the Indexer. --full ignores the stored state (clean rebuild). */
import { indexRepository } from "@duo-director/graph";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, requireProject, withRegistry, withWriter, type Env } from "./shared.js";

export async function indexCommand(env: Env, full: boolean): Promise<Outcome> {
  const project = requireProject(env, "index");
  if (project.value === undefined) return project.outcome as Outcome;
  const r = await withRegistry((registry) => withWriter(env.root, (store) => indexRepository(env.root, { store, registry, full })));
  if (r.value === undefined) return failed("index", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
  const m = r.value.metrics;
  const reason = r.value.fullRebuildReason === undefined ? "" : ` because ${r.value.fullRebuildReason === "requested" ? "requested" : r.value.fullRebuildReason}`;
  return {
    command: "index", exitCode: EXIT.OK, diagnostics: r.diagnostics.filter((d) => d.severity === "error"),
    result: { mode: r.value.mode, fullRebuildReason: r.value.fullRebuildReason ?? null, metrics: m, graphRevision: r.value.graphRevision },
    human: [t(env.locale, "index.done", { mode: r.value.mode, reason, files: m.files.total, analyzed: m.files.analyzed, changed: m.files.changed + m.files.added + m.files.deleted, written: m.graph.written ? "updated" : "unchanged" })],
    metric: { status: "ok", indexMode: r.value.mode, ...(r.value.fullRebuildReason === undefined ? {} : { fullRebuildReason: r.value.fullRebuildReason }) },
  };
}
