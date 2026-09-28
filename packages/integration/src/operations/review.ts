/**
 * duo review (CLI review, MCP duo_review_changes): the Review service as it is. Read-only; a stale
 * index is status index-required. The payload is the ReviewResult (duo.review/1); performance is
 * surface metadata.
 */
import type { GitDiffEnd } from "@duo-director/analyzer";
import { reviewChanges, type LLMProvider, type ReviewRequest, type ReviewResult } from "@duo-director/director";
import { errorsOf, guarded, project, withGraphReader, withRegistry, type Operation, type OperationOptions, type Failure } from "./common.js";

/** "HEAD", "INDEX", "WORKTREE" (any case) or a commit / branch name the Git provider resolves. */
export function diffEnd(value: string): GitDiffEnd {
  const upper = value.toUpperCase();
  return upper === "HEAD" || upper === "INDEX" || upper === "WORKTREE" ? (upper as GitDiffEnd) : { commit: value };
}

export function projectReview(root: string, request: ReviewRequest, options: OperationOptions & { readonly llm?: LLMProvider } = {}): Promise<Operation<ReviewResult>> {
  return guarded<ReviewResult>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    options.signal?.throwIfAborted();
    const r = await withRegistry(options.registry, (registry) => withGraphReader(root, (graph) => reviewChanges(root, request, {
      graph, registry, ...(options.llm === undefined ? {} : { llm: options.llm }), ...(options.signal === undefined ? {} : { signal: options.signal }),
    })));
    if (r.value === undefined) return { kind: "failed", diagnostics: r.diagnostics };
    return { kind: "ok", payload: r.value.result, performance: r.value.performance, diagnostics: errorsOf(r.value.result.diagnostics) };
  });
}
