/**
 * A DUO-managed block inside a human-owned text file: whole-line begin and end markers. Outside the
 * markers nothing is changed, byte for byte. Inserting appends the block after one blank line; removing
 * takes out exactly that block and the blank line before it, so install + remove restores the file.
 */

export interface Markers {
  readonly begin: string;
  readonly end: string;
}

export type BlockLocation =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: "malformed"; readonly reason: string };

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

interface Line { readonly start: number; readonly end: number; readonly text: string }

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    out.push({ start, end, text: text.slice(start, end).replace(/\r?\n$/u, "") });
    start = end;
  }
  return out;
}

export function findBlock(text: string, markers: Markers): BlockLocation {
  const all = lines(text);
  const begins = all.filter((l) => l.text.trim() === markers.begin);
  const ends = all.filter((l) => l.text.trim() === markers.end);
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  if (begins.length !== 1 || ends.length !== 1) return { kind: "malformed", reason: `${begins.length} begin and ${ends.length} end markers` };
  const b = begins[0] as Line;
  const e = ends[0] as Line;
  if (e.start < b.start) return { kind: "malformed", reason: "the end marker comes before the begin marker" };
  return { kind: "one", start: b.start, end: e.end, text: text.slice(b.start, e.end).replace(/\r?\n$/u, "") };
}

/** blockLines include the marker lines. The file's own line ending is kept. */
export function renderBlock(blockLines: readonly string[], existing: string | undefined): string {
  return blockLines.join(eolOf(existing ?? ""));
}

/** Inserts or replaces the block. Throws on a malformed file (callers inspect first). */
export function upsertBlock(existing: string | undefined, blockLines: readonly string[], markers: Markers): string {
  const text = existing ?? "";
  const eol = eolOf(text);
  const block = renderBlock(blockLines, text);
  const found = findBlock(text, markers);
  if (found.kind === "malformed") throw new Error(`malformed DUO block: ${found.reason}`);
  if (found.kind === "one") {
    const trailing = /\r?\n$/u.test(text.slice(found.start, found.end)) ? eol : "";
    return text.slice(0, found.start) + block + trailing + text.slice(found.end);
  }
  if (text === "") return block + eol;
  return text + (text.endsWith("\n") ? "" : eol) + eol + block + eol;
}

/** Removes the block and the blank line DUO put before it; undefined when there is no block. */
export function removeBlock(existing: string, markers: Markers): string | undefined {
  const found = findBlock(existing, markers);
  if (found.kind !== "one") return undefined;
  let before = existing.slice(0, found.start);
  const after = existing.slice(found.end);
  if (after === "") {
    if (before.endsWith("\r\n\r\n")) before = before.slice(0, -2);
    else if (before.endsWith("\n\n")) before = before.slice(0, -1);
  }
  return before + after;
}

export function blockText(existing: string | undefined, markers: Markers): string | undefined {
  if (existing === undefined) return undefined;
  const found = findBlock(existing, markers);
  return found.kind === "one" ? found.text.replace(/\r\n/gu, "\n") : undefined;
}
