/**
 * duoctl context <task> (T15): the Context Compiler, rendered as Markdown (default) or the domain
 * result (--json). A stale index is INDEX_REQUIRED; only --refresh indexes first.
 */
import { assessKnowledgeGaps, compileContext, renderContextMarkdown, renderGapQuestions } from "@duo-director/director";
import { indexRepository } from "@duo-director/graph";
import { t } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, requireProject, withReader, withRegistry, withWriter, type Env } from "./shared.js";

export async function contextCommand(env: Env, task: string, options: { readonly budget?: number; readonly refresh: boolean }): Promise<Outcome> {
  const project = requireProject(env, "context");
  if (project.value === undefined) return project.outcome as Outcome;
  const truth = project.value.truth;
  return withRegistry(async (registry) => {
    if (options.refresh) {
      const r = await withWriter(env.root, (store) => indexRepository(env.root, { store, registry }));
      if (r.value === undefined) return failed("context", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
    }
    const compiled = await withReader(env.root, (graph) => compileContext(env.root, { task, ...(options.budget === undefined ? {} : { budget: options.budget }) }, { graph, registry }));
    if (compiled.value === undefined) return failed("context", EXIT.ERROR, compiled.diagnostics, diagLines(compiled.diagnostics), null, { status: "failed" });
    const c = compiled.value;
    const metric = { status: c.status, contextStatus: c.status, ...(c.packet === undefined ? {} : { contextTokens: c.packet.metrics.budget.used, contextBudget: c.packet.metrics.budget.total }), llmCalls: 0 };
    if (c.status === "index-required") {
      return { command: "context", exitCode: EXIT.ACTION_REQUIRED, result: c, diagnostics: [], human: [t(env.locale, "index.required", { status: c.freshness.status })], metric };
    }
    const human: string[] = [];
    if (c.packet !== undefined) human.push(renderContextMarkdown(c.packet));
    else human.push(t(env.locale, "context.status", { status: c.status }));
    if (c.status !== "ready") {
      const q = renderGapQuestions(assessKnowledgeGaps({ request: { task }, result: c, truth }), { locale: env.locale });
      if (q.primaryQuestion !== undefined) human.push(`? ${q.primaryQuestion}`);
      human.push(...q.additionalQuestions.map((a) => `? ${a.question}`), ...q.notes.map((n) => `- ${n.note}`));
    }
    return { command: "context", exitCode: EXIT.OK, result: c, diagnostics: c.diagnostics.filter((d) => d.severity === "error"), human, metric };
  });
}
