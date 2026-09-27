/**
 * External Source provenance (ADR-014, T13.1). A Truth item may cite an external document as
 * { path, hash, section? }. The hash is sha256 of the canonical source text (one leading BOM
 * removed, CRLF → LF): the whole file, or, with section, the Markdown section that starts at the
 * first heading with exactly that text and runs to the next heading of the same or a higher level.
 * Only repository-local paths can be read; remote sources (URL, Jira, GitHub, Linear) cannot.
 */
import type { SourceLocation } from "./diagnostics.js";
import { sha256Text } from "./evidence.js";
import { canonicalSourceText } from "./location.js";
import { parseMarkdown } from "./source/markdown.js";

const MARKDOWN = /\.(?:md|markdown|mdx)$/iu;
/** "https://…", "jira:ABC-1", "github:owner/repo#1", "//host/…". A Windows drive ("C:\\") is not a scheme. */
const SCHEME = /^(?:[A-Za-z][A-Za-z0-9+.-]+:|\/\/)/u;

/** A source DUO cannot read from the repository (a URL or another system's reference). */
export function isRemoteSourcePath(path: string): boolean {
  return SCHEME.test(path);
}

export type ExternalSourceSlice =
  | { readonly status: "ok"; readonly text: string; readonly hash: string; readonly location: SourceLocation }
  | { readonly status: "section-missing" }
  | { readonly status: "section-unsupported" };

/** The text a { path, hash, section? } reference covers, and its hash. */
export function externalSourceSlice(path: string, rawText: string, section?: string): ExternalSourceSlice {
  const text = canonicalSourceText(rawText);
  if (section === undefined) return { status: "ok", text, hash: sha256Text(text), location: { path } };
  if (!MARKDOWN.test(path)) return { status: "section-unsupported" };
  const doc = parseMarkdown(path, text).value;
  if (doc === undefined) return { status: "section-missing" };
  const headings = doc.blocks.flatMap((b) => (b.kind === "heading" ? [b] : []));
  const wanted = section.trim();
  const i = headings.findIndex((h) => h.text.trim() === wanted);
  const heading = headings[i];
  if (heading === undefined) return { status: "section-missing" };
  const next = headings.slice(i + 1).find((h) => h.depth <= heading.depth);
  const end = next?.start ?? doc.length;
  const slice = doc.slice(heading.start, end);
  return { status: "ok", text: slice, hash: sha256Text(slice), location: doc.locationOf(heading.start, end) };
}

/**
 * Compares a recorded provenance hash with an observed "sha256:<hex>". The recorded value may
 * omit the "sha256:" prefix and may be abbreviated to at least 7 hex digits (as Git abbreviates).
 */
export function compareSourceHash(recorded: string, observed: string): "match" | "mismatch" | "invalid" {
  const hex = recorded.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[0-9a-f]{7,64}$/u.test(hex)) return "invalid";
  return observed.slice("sha256:".length).startsWith(hex) ? "match" : "mismatch";
}
