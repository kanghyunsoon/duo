/**
 * Source retrieval for the Context Compiler (TASK-010). Every text comes from readSourceFile(),
 * which re-checks the repository boundary and refuses symlinks, and every range from
 * sliceSource(), which refuses a location that does not fit instead of clamping it (T09.1). A
 * candidate whose location does not slice keeps its name-only representation.
 */
import { performance } from "node:perf_hooks";
import { readSourceFile, sliceSource, success, type ParseResult, type SourceLocation } from "@duo-director/core";
import { LEADING_CONTEXT_LINES } from "./policy.js";

export interface ContextSlice {
  readonly text: string;
  readonly startLine: number;
}

const LEADING = /^\s*(?:\/\/|\/\*|\*|@)/u;
/** Python: "#" comment lines too (T18.0). Not in other languages, where "#" starts a directive or a private field. */
const LEADING_PY = /^\s*(?:#|@)/u;

export interface HeadWindow {
  readonly text: string;
  readonly endLine: number;
  /** The file has more lines than the window shows. */
  readonly truncated: boolean;
}

export class SourceReader {
  /** Milliseconds spent reading and slicing. */
  ms = 0;
  private readonly files = new Map<string, ParseResult<string>>();

  constructor(private readonly root: string) {}

  text(path: string): ParseResult<string> {
    const t0 = performance.now();
    let r = this.files.get(path);
    if (r === undefined) {
      r = readSourceFile(this.root, path);
      this.files.set(path, r);
    }
    this.ms += performance.now() - t0;
    return r;
  }

  /** The exact text of a location. */
  slice(location: SourceLocation): ParseResult<string> {
    const text = this.text(location.path);
    if (text.value === undefined) return text;
    const t0 = performance.now();
    const r = sliceSource(text.value, location);
    this.ms += performance.now() - t0;
    return r;
  }

  /**
   * A code range with its minimal surrounding context: the start line from column 1 (indentation,
   * "export") and the comment or decorator lines directly above it. The range itself is validated
   * exactly first.
   */
  withLeadingContext(location: SourceLocation): ParseResult<ContextSlice> {
    const exact = this.slice(location);
    if (exact.value === undefined || location.startLine === undefined) return exact.value === undefined ? { diagnostics: exact.diagnostics } : success({ text: exact.value, startLine: 1 });
    const text = this.text(location.path).value ?? "";
    const t0 = performance.now();
    const lines = text.split("\n");
    const leading = location.path.endsWith(".py") ? LEADING_PY : LEADING;
    let start = location.startLine;
    while (start > 1 && location.startLine - (start - 1) <= LEADING_CONTEXT_LINES && leading.test(lines[start - 2] ?? "")) start--;
    const r = sliceSource(text, { ...location, startLine: start, startColumn: 1 });
    this.ms += performance.now() - t0;
    return r.value === undefined ? { diagnostics: r.diagnostics } : success({ text: r.value, startLine: start });
  }

  /** The first whole lines of a file within both bounds (T18.0 generic files); undefined when it cannot be read as text. */
  headWindow(path: string, bounds: { readonly lines: number; readonly chars: number }): HeadWindow | undefined {
    const text = this.text(path).value;
    if (text === undefined || text.trim() === "") return undefined;
    const all = text.split("\n");
    const kept: string[] = [];
    let size = 0;
    for (const line of all.slice(0, bounds.lines)) {
      if (size + line.length + 1 > bounds.chars && kept.length > 0) break;
      // A single over-long line (minified): cut at the bound, never inside a surrogate pair.
      const cut = /[\uD800-\uDBFF]/u.test(line[bounds.chars - 1] ?? "") ? bounds.chars - 1 : bounds.chars;
      kept.push(line.length > bounds.chars ? line.slice(0, cut) : line);
      size += line.length + 1;
    }
    const lastIsEmpty = all.length > 0 && all[all.length - 1] === "";
    const total = lastIsEmpty ? all.length - 1 : all.length;
    return { text: kept.join("\n"), endLine: kept.length, truncated: kept.length < total || (all[0] ?? "").length > bounds.chars };
  }
}
