/**
 * Markdown source parsing. Only this layer knows mdast/micromark; it returns DUO-owned
 * structures (headings, fenced code, list items, links, text) with source positions.
 */
import type { Nodes, Paragraph, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import { createDiagnostic, failure, success, type ParseResult, type SourceLocation } from "../diagnostics.js";

/** Offsets are 0-based character offsets into the document text. */
export interface MarkdownSpan {
  readonly start: number;
  readonly end: number;
  readonly location: SourceLocation;
}

export interface MarkdownHeading extends MarkdownSpan {
  readonly kind: "heading";
  readonly depth: number;
  /** Plain text of the heading. */
  readonly text: string;
}

export interface MarkdownCodeBlock extends MarkdownSpan {
  readonly kind: "code";
  /** Info string of a fenced block, e.g. "duo". Undefined for indented code. */
  readonly lang: string | undefined;
  readonly value: string;
  /** File line of the first content line. */
  readonly contentStartLine: number;
}

export interface MarkdownOtherBlock extends MarkdownSpan {
  readonly kind: "other";
}

/** Top-level block in document order. */
export type MarkdownBlock = MarkdownHeading | MarkdownCodeBlock | MarkdownOtherBlock;

export interface MarkdownListItem extends MarkdownSpan {
  /** Text of a leading **strong** run in the item's first paragraph, if any. */
  readonly leadingStrong: string | undefined;
  /** Plain text of the first paragraph without the leading strong run. */
  readonly text: string;
}

export interface MarkdownFrontmatter extends MarkdownSpan {
  readonly value: string;
  readonly contentStartLine: number;
}

export interface MarkdownLink {
  readonly url: string;
  readonly location: SourceLocation;
}

export interface MarkdownText {
  readonly value: string;
  readonly location: SourceLocation;
}

/**
 * A known-unknown marker (TASK-011): a prose line that starts with "UNKNOWN:" or "UNKNOWN(key):".
 * Found only in paragraph text of the Markdown AST: fenced and indented code, inline code, HTML and
 * YAML frontmatter never produce one.
 */
export interface MarkdownUnknownMarker {
  /** Offset of the marker in the document text. */
  readonly start: number;
  /** Optional question key, e.g. "max_concurrent_users" in "UNKNOWN(max_concurrent_users): …". */
  readonly key: string | undefined;
  /** Text after the colon (inline code keeps its value). */
  readonly text: string;
  /** From "UNKNOWN" to the end of its source line. */
  readonly location: SourceLocation;
}

export interface MarkdownDocument {
  readonly path: string;
  readonly length: number;
  readonly lineCount: number;
  readonly frontmatter: MarkdownFrontmatter | undefined;
  readonly blocks: readonly MarkdownBlock[];
  /** List items at any depth, in document order. */
  readonly listItems: readonly MarkdownListItem[];
  readonly links: readonly MarkdownLink[];
  /** Text, inline code, code and HTML values, for mention scanning. */
  readonly texts: readonly MarkdownText[];
  /** UNKNOWN markers in prose, in document order. */
  readonly unknownMarkers: readonly MarkdownUnknownMarker[];
  slice(start: number, end: number): string;
  locationOf(start: number, end: number): SourceLocation;
}

function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if ("children" in node) return (node.children as Nodes[]).map(plainText).join("");
  return "";
}

const UNKNOWN_LINE = /^UNKNOWN(?:\(([A-Za-z0-9_.-]+)\))?:\s*(.*)$/u;
/** Stands for inline code while looking for markers, so `UNKNOWN: x` in backticks is not one. */
const CODE_MARK = "\uFFFC";

/** A paragraph's lines twice: for detection (inline code masked) and for display (inline code kept). */
function paragraphLines(p: Paragraph): { detect: string[]; display: string[] } {
  let detect = "";
  let display = "";
  const visit = (node: Nodes): void => {
    if (node.type === "text") { detect += node.value; display += node.value; }
    else if (node.type === "inlineCode") { detect += CODE_MARK; display += node.value.replace(/\n/gu, " "); }
    else if (node.type === "html") { detect += CODE_MARK; display += node.value.replace(/\n/gu, " "); }
    else if (node.type === "break") { detect += "\n"; display += "\n"; }
    else if ("children" in node) for (const child of node.children as Nodes[]) visit(child);
  };
  for (const child of p.children) visit(child);
  return { detect: detect.split("\n"), display: display.split("\n") };
}

export function parseMarkdown(path: string, text: string): ParseResult<MarkdownDocument> {
  let tree: Root;
  try {
    tree = fromMarkdown(text, { extensions: [frontmatter(["yaml"])], mdastExtensions: [frontmatterFromMarkdown(["yaml"])] });
  } catch (error) {
    return failure([createDiagnostic("MARKDOWN_PARSE_ERROR", String(error), { path })]);
  }

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const locationOf = (start: number, end: number): SourceLocation => {
    const sl = lineAt(start);
    // [start, end): the end is the position of offset end itself. A range that ends right after a
    // line break ends at column 1 of the next line; the end of the text is offset text.length.
    const stop = Math.max(start, end);
    const el = lineAt(stop);
    return {
      path,
      startLine: sl,
      startColumn: start - (lineStarts[sl - 1] ?? 0) + 1,
      endLine: el,
      endColumn: stop - (lineStarts[el - 1] ?? 0) + 1,
    };
  };
  const spanOf = (node: Nodes): MarkdownSpan | undefined => {
    const p = node.position;
    if (p?.start.offset === undefined || p.end.offset === undefined) return undefined;
    return { start: p.start.offset, end: p.end.offset, location: locationOf(p.start.offset, p.end.offset) };
  };

  let front: MarkdownFrontmatter | undefined;
  const blocks: MarkdownBlock[] = [];
  const listItems: MarkdownListItem[] = [];
  const links: MarkdownLink[] = [];
  const texts: MarkdownText[] = [];
  const unknownMarkers: MarkdownUnknownMarker[] = [];
  const lineText = (line: number): { start: number; text: string } => {
    const start = lineStarts[line - 1] ?? text.length;
    const next = lineStarts[line];
    return { start, text: text.slice(start, next === undefined ? text.length : next - 1) };
  };
  const markersOf = (p: Paragraph): void => {
    const first = p.position?.start.line;
    if (first === undefined) return;
    const { detect, display } = paragraphLines(p);
    detect.forEach((raw, i) => {
      const m = UNKNOWN_LINE.exec(raw.trim());
      const shown = UNKNOWN_LINE.exec((display[i] ?? "").trim());
      if (m === null || shown === null) return;
      const body = (shown[2] ?? "").trim();
      if (body === "") return;
      const src = lineText(first + i);
      const at = Math.max(0, src.text.indexOf("UNKNOWN"));
      unknownMarkers.push({ start: src.start + at, key: m[1], text: body, location: locationOf(src.start + at, src.start + src.text.length) });
    });
  };

  for (const child of tree.children) {
    const span = spanOf(child);
    if (span === undefined) continue;
    if (child.type === "yaml") {
      front = { ...span, value: child.value, contentStartLine: (span.location.startLine ?? 1) + 1 };
    } else if (child.type === "heading") {
      blocks.push({ ...span, kind: "heading", depth: child.depth, text: plainText(child).trim() });
    } else if (child.type === "code") {
      const fenced = text.slice(span.start, span.start + 3) === "```" || text.slice(span.start, span.start + 3) === "~~~";
      blocks.push({
        ...span,
        kind: "code",
        lang: fenced && child.lang ? child.lang : undefined,
        value: child.value,
        contentStartLine: (span.location.startLine ?? 1) + (fenced ? 1 : 0),
      });
    } else {
      blocks.push({ ...span, kind: "other" });
    }
  }

  const walk = (node: Nodes): void => {
    const span = spanOf(node);
    if (span !== undefined) {
      if (node.type === "text" || node.type === "inlineCode" || node.type === "code" || node.type === "html" || node.type === "yaml") {
        texts.push({ value: node.value, location: span.location });
      } else if (node.type === "paragraph") {
        markersOf(node);
      } else if (node.type === "link" || node.type === "definition") {
        links.push({ url: node.url, location: span.location });
      } else if (node.type === "listItem") {
        const first = node.children[0];
        let leadingStrong: string | undefined;
        let itemText = "";
        if (first?.type === "paragraph") {
          const [head, ...rest] = first.children;
          if (head?.type === "strong") {
            leadingStrong = plainText(head).trim();
            itemText = rest.map(plainText).join("").trim();
          } else {
            itemText = plainText(first).trim();
          }
        }
        listItems.push({ ...span, leadingStrong, text: itemText });
      }
    }
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(tree);

  return success({
    path,
    length: text.length,
    lineCount: lineStarts.length,
    frontmatter: front,
    blocks,
    listItems,
    links,
    texts,
    unknownMarkers,
    slice: (start, end) => text.slice(start, end),
    locationOf,
  });
}
