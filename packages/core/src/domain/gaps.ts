/**
 * Declared Knowledge Gaps (TASK-011): known unknowns a human wrote into Project Truth as
 * "UNKNOWN: …" prose lines. They are derived facts of the Truth documents, not Graph nodes and not
 * stored anywhere. Each gap belongs to the innermost definition section that contains it, or to
 * the project when no definition does.
 *
 * Identity is owner + optional key + normalized text, never a line number: adding a line above a
 * gap keeps its ID; editing its text makes it a different gap.
 */
import { createHash } from "node:crypto";
import { nodeId, PROJECT_REF, type DefinitionRef, type ProjectRef } from "../ids.js";
import type { MarkdownDocument } from "../source/markdown.js";
import type { DeclaredGap } from "./model.js";

/** NFC, whitespace collapsed, trimmed, lower-cased (locale-independent). */
export function normalizeGapText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function declaredGapId(owner: DefinitionRef | ProjectRef, key: string | undefined, text: string): string {
  const input = `${nodeId(owner)}\n${key ?? ""}\n${normalizeGapText(text)}`;
  return `gap-${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
}

export interface GapSection {
  readonly start: number;
  readonly end: number;
  readonly owner: DefinitionRef;
}

/** Markers of a document assigned to the innermost enclosing definition section, else to the project. */
export function declaredGapsOf(doc: MarkdownDocument, sections: readonly GapSection[]): DeclaredGap[] {
  const out: DeclaredGap[] = [];
  const seen = new Set<string>();
  for (const m of doc.unknownMarkers) {
    let owner: DefinitionRef | ProjectRef = PROJECT_REF;
    let width = Infinity;
    for (const s of sections) {
      if (m.start >= s.start && m.start < s.end && s.end - s.start < width) { owner = s.owner; width = s.end - s.start; }
    }
    const id = declaredGapId(owner, m.key, m.text);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "declared-gap", id, owner, ...(m.key === undefined ? {} : { key: m.key }), text: m.text, location: m.location });
  }
  return out;
}
