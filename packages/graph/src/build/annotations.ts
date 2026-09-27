/**
 * Annotation attachment (TASK-007, 04 reserved rule), computed from Analyzer locations and the
 * source text; nothing is parsed again. Targets are Symbols and Tests (a test is where a
 * requirement annotation means VALIDATED_BY).
 *
 * 1. Next target: between the annotation and the target's start there is no code token (only
 *    whitespace, comments, and declaration keywords such as "export") and at most one blank line.
 * 2. Otherwise the smallest Symbol or Test whose range contains the annotation.
 * 3. Otherwise the File.
 */
import type { SourceLocation } from "@duo-director/core";

export interface AttachmentCandidate<T> {
  readonly value: T;
  readonly location: SourceLocation;
}

export type Attachment<T> =
  | { readonly kind: "next" | "enclosing"; readonly value: T }
  | { readonly kind: "file" };

/** Keywords that may sit between a comment and the declaration node it documents. */
const DECLARATION_KEYWORDS = /\b(?:export|default|declare|const|let|var|abstract|async)\b/gu;
const MAX_BLANK_LINES = 1;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function offset(starts: readonly number[], line: number | undefined, column: number | undefined): number | undefined {
  if (line === undefined || column === undefined) return undefined;
  const start = starts[line - 1];
  return start === undefined ? undefined : start + column - 1;
}

/** True when gap has no code token and at most MAX_BLANK_LINES blank lines. */
function onlyTrivia(gap: string): boolean {
  let rest = gap;
  // The annotation may sit inside a block comment that closes after it.
  const close = rest.indexOf("*/");
  const open = rest.indexOf("/*");
  if (close !== -1 && (open === -1 || close < open)) rest = rest.slice(close + 2);
  const lines = rest.split("\n");
  const blank = lines.slice(1, -1).filter((l) => l.trim() === "").length;
  if (blank > MAX_BLANK_LINES) return false;
  const code = rest.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "").replace(DECLARATION_KEYWORDS, "");
  return code.trim() === "";
}

export function attachAnnotation<T>(
  annotation: SourceLocation,
  candidates: readonly AttachmentCandidate<T>[],
  text: string | undefined,
): Attachment<T> {
  if (text !== undefined) {
    const normalized = text.replace(/\r\n/gu, "\n");
    const starts = lineStarts(normalized);
    const end = offset(starts, annotation.endLine, annotation.endColumn);
    if (end !== undefined) {
      let next: { value: T; start: number } | undefined;
      for (const c of candidates) {
        const start = offset(starts, c.location.startLine, c.location.startColumn);
        if (start === undefined || start < end) continue;
        if (next === undefined || start < next.start) next = { value: c.value, start };
      }
      if (next !== undefined && onlyTrivia(normalized.slice(end, next.start))) return { kind: "next", value: next.value };
      const begin = offset(starts, annotation.startLine, annotation.startColumn);
      let inner: { value: T; size: number } | undefined;
      for (const c of candidates) {
        const s = offset(starts, c.location.startLine, c.location.startColumn);
        const e = offset(starts, c.location.endLine, c.location.endColumn);
        if (s === undefined || e === undefined || begin === undefined || s > begin || e < end) continue;
        if (inner === undefined || e - s < inner.size) inner = { value: c.value, size: e - s };
      }
      if (inner !== undefined) return { kind: "enclosing", value: inner.value };
    }
  }
  return { kind: "file" };
}
