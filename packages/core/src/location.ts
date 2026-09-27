/**
 * SourceLocation helpers (T05). Lines are 1-based and counted by LF; columns are 1-based UTF-16
 * code units (JavaScript string indices + 1), endColumn exclusive. A CR before an LF belongs to
 * the end of its line, so the same location addresses the same text in LF and CRLF checkouts.
 *
 * T09.1: every SourceLocation addresses the canonical source text (canonicalSourceText: one
 * leading BOM removed, CRLF → LF). A range is [start, end): the end of a definition that runs to
 * the end of the file is the position after the last character (offset source.length), never an
 * invented line or column past it. Producers parse the canonical text, so every location they make
 * slices exactly; sliceSource() refuses anything else instead of clamping it.
 */
import { createDiagnostic, failure, success, type ParseResult, type SourceLocation } from "./diagnostics.js";
import { compareUtf8 } from "./order.js";

/** Order: path (UTF-8), startLine, startColumn, endLine, endColumn. Missing numbers sort first. */
export function compareSourceLocations(a: SourceLocation, b: SourceLocation): number {
  if (a.path !== b.path) return compareUtf8(a.path, b.path);
  const keys = ["startLine", "startColumn", "endLine", "endColumn"] as const;
  for (const key of keys) {
    const x = a[key] ?? 0;
    const y = b[key] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The text SourceLocations address: one leading U+FEFF removed and every CRLF turned into LF. */
export function canonicalSourceText(raw: string): string {
  return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
}

/** A location with a full range (all four numbers). Path-only locations address the whole file. */
export function hasSourceRange(location: SourceLocation): boolean {
  return location.startLine !== undefined && location.startColumn !== undefined && location.endLine !== undefined && location.endColumn !== undefined;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * The text a location covers, or undefined when the location has no complete range or does not
 * fit the text. Evidence uses this to find the exact source slice again.
 */
export function sliceSourceLocation(text: string, location: SourceLocation): string | undefined {
  const { startLine, startColumn, endLine, endColumn } = location;
  if (startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined) return undefined;
  const starts = lineStarts(text);
  const offset = (line: number, column: number): number | undefined => {
    const start = starts[line - 1];
    if (start === undefined || column < 1) return undefined;
    const next = starts[line] ?? text.length + 1;
    const value = start + column - 1;
    return value <= next - 1 ? value : undefined;
  };
  const from = offset(startLine, startColumn);
  const to = offset(endLine, endColumn);
  return from === undefined || to === undefined || to < from ? undefined : text.slice(from, to);
}

/**
 * The exact text of a location in canonical source text. Path-only locations yield the whole text.
 * A partial range, or one that does not fit the text, is a producer bug: SOURCE_LOCATION_INVALID,
 * never a clamped slice.
 */
export function sliceSource(canonicalText: string, location: SourceLocation): ParseResult<string> {
  const { startLine, startColumn, endLine, endColumn } = location;
  if (startLine === undefined && startColumn === undefined && endLine === undefined && endColumn === undefined) return success(canonicalText);
  if (!hasSourceRange(location)) {
    return failure([createDiagnostic("SOURCE_LOCATION_INVALID", `${location.path}: incomplete range ${JSON.stringify({ startLine, startColumn, endLine, endColumn })}`, location)]);
  }
  const slice = sliceSourceLocation(canonicalText, location);
  return slice === undefined
    ? failure([createDiagnostic("SOURCE_LOCATION_INVALID", `${location.path}: ${startLine}:${startColumn}-${endLine}:${endColumn} is outside the source`, location)])
    : success(slice);
}
