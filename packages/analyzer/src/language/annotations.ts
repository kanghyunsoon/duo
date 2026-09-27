/**
 * DUO code annotations (TASK-005): comment lines of the form "duo: AUTH-03, AUTH-04". Called only
 * with the text of comment nodes, so "duo:" inside a string literal is never an annotation.
 * IDs are syntax candidates (DEFINITION_ID_PATTERN); the Graph Builder checks them against Project Truth.
 */
import { createDiagnostic, isDefinitionId, type Diagnostic, type RepoPath } from "@duo-director/core";
import type { DuoAnnotation } from "./types.js";

export interface AnnotationResult {
  readonly annotations: DuoAnnotation[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Parses one comment. startLine/startColumn are the comment's 1-based position (UTF-16 columns).
 * Supported: "// duo: ...", "/* duo: ... *\/", and block comment lines " * duo: ...".
 * A "duo:" must start the comment line (after the comment marker, spaces and a leading "*").
 */
export function parseDuoAnnotations(path: RepoPath, comment: string, startLine: number, startColumn: number): AnnotationResult {
  const annotations: DuoAnnotation[] = [];
  const diagnostics: Diagnostic[] = [];
  const block = comment.startsWith("/*");
  if (!block && !comment.startsWith("//")) return { annotations, diagnostics };
  const lines = comment.split("\n");
  lines.forEach((raw, k) => {
    let offset = 0;
    if (k === 0) {
      offset = 2;
      while (block && raw[offset] === "*") offset++;
    } else {
      while (raw[offset] === " " || raw[offset] === "\t") offset++;
      if (raw[offset] === "*" && raw[offset + 1] !== "/") offset++;
    }
    const body = raw.slice(offset);
    const content = body.trimStart();
    if (!content.startsWith("duo:")) return;
    let text = content;
    if (block && k === lines.length - 1 && text.trimEnd().endsWith("*/")) text = text.trimEnd().slice(0, -2);
    text = text.trimEnd();
    const index = offset + (body.length - content.length);
    const column = k === 0 ? startColumn + index : index + 1;
    const location = { path, startLine: startLine + k, startColumn: column, endLine: startLine + k, endColumn: column + text.length };
    // Leading ID tokens; the first token that is not an ID starts free text ("duo: AUTH-07 — login helper").
    const tokens = text.slice("duo:".length).split(/[\s,]+/).filter((t) => t !== "");
    const end = tokens.findIndex((t) => !isDefinitionId(t));
    const ids = [...new Set(end === -1 ? tokens : tokens.slice(0, end))];
    if (ids.length === 0) {
      diagnostics.push(createDiagnostic("DUO_ANNOTATION_INVALID", `"duo:" comment does not start with a definition ID: ${JSON.stringify(text)}`, location));
      return;
    }
    annotations.push({ ids, location });
  });
  return { annotations, diagnostics };
}
