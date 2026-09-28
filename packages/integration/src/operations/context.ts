/**
 * duo context (CLI context, MCP duo_get_context): the Context Compiler plus the Knowledge Gap
 * assessment, structured. Never indexes: a stale index is status index-required.
 */
import { assessKnowledgeGaps, compileContext, renderGapQuestions, type ContextResult, type KnowledgeGapAssessment } from "@duo-director/director";
import { errorsOf, guarded, project, withGraphReader, withRegistry, type Operation, type OperationOptions, type Failure } from "./common.js";

export const CONTEXT_FORMAT = "duo.context/1";
export const GAP_NOTICE = "Surfaced gaps are open questions DUO noticed, not confirmed instructions. Ask the human only when requiresHumanInput is true.";

export interface ContextRequestInput {
  readonly task: string;
  readonly budget?: number;
  readonly profile?: "default" | "review";
}

export interface ContextPayload {
  readonly format: typeof CONTEXT_FORMAT;
  readonly status: ContextResult["status"];
  /** The ContextResult without its wall-clock performance. */
  readonly context: Omit<ContextResult, "performance">;
  readonly gaps: {
    readonly requiresHumanInput: boolean;
    readonly primaryQuestion?: { readonly id: string; readonly question: string };
    readonly additionalQuestions: readonly { readonly id: string; readonly question: string }[];
    readonly surfaced: readonly { readonly id: string; readonly note: string }[];
    readonly notice: string;
    readonly assessment: KnowledgeGapAssessment;
  } | null;
}

export function projectContext(root: string, input: ContextRequestInput, options: OperationOptions = {}): Promise<Operation<ContextPayload>> {
  return guarded<ContextPayload>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const truth = p.value.truth;
    options.signal?.throwIfAborted();
    const compiled = await withRegistry(options.registry, (registry) => withGraphReader(root, (graph) => compileContext(root, {
      task: input.task, ...(input.budget === undefined ? {} : { budget: input.budget }), ...(input.profile === undefined ? {} : { profile: input.profile }),
    }, { graph, registry })));
    if (compiled.value === undefined) return { kind: "failed", diagnostics: compiled.diagnostics };
    const { performance, ...context } = compiled.value;
    let gaps: ContextPayload["gaps"] = null;
    if (context.status !== "index-required") {
      const assessment = assessKnowledgeGaps({ request: { task: input.task }, result: compiled.value, truth });
      const q = renderGapQuestions(assessment, { locale: "en" });
      const primary = assessment.primary;
      gaps = {
        requiresHumanInput: assessment.requiresHumanInput,
        ...(primary === undefined || q.primaryQuestion === undefined ? {} : { primaryQuestion: { id: primary, question: q.primaryQuestion } }),
        additionalQuestions: q.additionalQuestions, surfaced: q.notes, notice: GAP_NOTICE, assessment,
      };
    }
    return { kind: "ok", performance, diagnostics: errorsOf(compiled.diagnostics), payload: { format: CONTEXT_FORMAT, status: context.status, context, gaps } };
  });
}
