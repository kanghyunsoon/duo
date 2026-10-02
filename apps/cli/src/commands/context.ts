/**
 * duoctl context <task> (T15): the shared context operation (Context Packet + Knowledge Gap
 * assessment), rendered as Markdown. A stale index is INDEX_REQUIRED; only --refresh indexes first.
 */
import { ambiguityRemediation, redactSecrets, renderContextMarkdown, renderGapQuestions, type SeedAmbiguity } from "@duo-director/director";
import { indexRepository } from "@duo-director/graph";
import { projectContext, withGraphWriter } from "@duo-director/integration";
import { t, type Locale } from "../messages.js";
import { EXIT, failed, type Outcome } from "../output.js";
import { diagLines, operationFailure, requireProject, withRegistry, type Env } from "./shared.js";

export async function contextCommand(env: Env, task: string, options: { readonly budget?: number; readonly refresh: boolean }): Promise<Outcome> {
  const project = requireProject(env, "context");
  if (project.value === undefined) return project.outcome as Outcome;
  return withRegistry(async (registry) => {
    if (options.refresh) {
      const r = await withGraphWriter(env.root, (store) => indexRepository(env.root, { store, registry }));
      if (r.value === undefined) return failed("context", EXIT.ERROR, r.diagnostics, diagLines(r.diagnostics), null, { status: "failed" });
    }
    const op = await projectContext(env.root, { task, ...(options.budget === undefined ? {} : { budget: options.budget }) }, { registry });
    if (op.kind !== "ok") return operationFailure(env, "context", op);
    const p = op.payload;
    const packet = p.context.packet;
    const metric = { status: p.status, contextStatus: p.status, ...(packet === undefined ? {} : { contextTokens: packet.metrics.budget.used, contextBudget: packet.metrics.budget.total }), llmCalls: 0 };
    const meta = { performance: op.performance };
    if (p.status === "index-required") {
      return { command: "context", exitCode: EXIT.ACTION_REQUIRED, result: p, meta, diagnostics: [], human: [t(env.locale, "index.required", { status: p.context.freshness.status })], metric };
    }
    const human: string[] = [packet === undefined ? t(env.locale, "context.status", { status: p.status }) : renderContextMarkdown(packet)];
    if (p.status !== "ready" && p.gaps !== null) {
      const q = renderGapQuestions(p.gaps.assessment, { locale: env.locale });
      if (q.primaryQuestion !== undefined) human.push(`? ${q.primaryQuestion}`);
      human.push(...q.additionalQuestions.map((a) => `? ${a.question}`), ...q.notes.map((n) => `- ${n.note}`));
    }
    // T26.1/T26.2: only the handles that tell the candidates apart (human output only; the result is unchanged).
    if (p.status === "ambiguous") human.push(...(p.context.resolution?.ambiguities ?? []).flatMap((a) => ambiguityHint(env.locale, a)));
    return { command: "context", exitCode: EXIT.OK, result: p, meta, diagnostics: op.diagnostics, human, metric };
  });
}

function ambiguityHint(L: Locale, a: SeedAmbiguity): string[] {
  const r = ambiguityRemediation(a);
  const has = (h: string) => r.handles.includes(h as never);
  const key = has("definition-id") ? "context.ambiguous.definition-id" : has("path") && has("qualified-name") ? "context.ambiguous.both"
    : has("path") ? "context.ambiguous.path" : has("qualified-name") ? "context.ambiguous.qualified-name" : "context.ambiguous.none";
  return [t(L, key, { term: a.term }), ...(r.definitionIdAlso ? [t(L, "context.ambiguous.id-also")] : [])].map((line) => redactSecrets(line).text);
}
