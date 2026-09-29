/**
 * duo review (CLI review, MCP duo_review_changes): the Review service as it is. Read-only; a stale
 * index is status index-required. The payload is the ReviewResult (duo.review/1); performance is
 * surface metadata. Semantic assistance (T12B) runs only when the request sets includeSemanticAssist
 * and project.yaml configures a provider; the provider comes from the shared LLM factory, so CLI and
 * MCP make the same call.
 */
import type { GitDiffEnd } from "@duo-director/analyzer";
import { reviewChanges, type ReviewRequest, type ReviewResult } from "@duo-director/director";
import { errorsOf, guarded, llmPoolOf, project, withGraphReader, withRegistry, type Operation, type OperationOptions, type Failure } from "./common.js";

/** "HEAD", "INDEX", "WORKTREE" (any case) or a commit / branch name the Git provider resolves. */
export function diffEnd(value: string): GitDiffEnd {
  const upper = value.toUpperCase();
  return upper === "HEAD" || upper === "INDEX" || upper === "WORKTREE" ? (upper as GitDiffEnd) : { commit: value };
}

export function projectReview(root: string, request: ReviewRequest, options: OperationOptions = {}): Promise<Operation<ReviewResult>> {
  return guarded<ReviewResult>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    options.signal?.throwIfAborted();
    const llmConfig = p.value.truth.config.llm;
    const llm = llmPoolOf(options).forConfig(llmConfig).provider;
    const r = await withRegistry(options.registry, (registry) => withGraphReader(root, (graph) => reviewChanges(root, request, {
      graph, registry, llm, llmCache: llmConfig.cache, ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.tokenCounts === undefined ? {} : { tokenCounts: options.tokenCounts }),
    })));
    if (r.value === undefined) return { kind: "failed", diagnostics: r.diagnostics };
    return { kind: "ok", payload: r.value.result, performance: r.value.performance, diagnostics: errorsOf(r.value.result.diagnostics) };
  });
}
