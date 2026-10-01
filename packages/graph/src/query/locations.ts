/**
 * Every source location of a Graph node (T24.1, C217). An analyzer merges declarations with the same
 * identity into one Symbol (Java, C# and C++ overloads, a TypeScript overload signature and its
 * implementation, a getter and setter pair, a Python redefinition): the primary location is
 * node.source and the others are payload.additionalLocations. Consumers that read or match source
 * text (Context, Evidence, Review diff seeds) use all of them, so a merged declaration is never
 * silently absent. The Symbol identity is unchanged.
 *
 * - order: canonical source order (core compareSourceLocations), independent of which location is
 *   primary and of the order the analyzer met the declarations
 * - duplicates: a range listed twice, or an additional location equal to the primary, appears once
 * - containment: a location inside another location of the same node adds no text and is dropped
 * - scope: only locations in the node's own file; a malformed payload entry is ignored
 *
 * A node without node.source has no locations. Locations are line and column ranges of the canonical
 * source text (BOM removed, CRLF read as LF: core canonicalSourceText), like node.source itself.
 */
import { compareSourceLocations, type SourceLocation } from "@duo-director/core";
import type { GraphNode } from "../store/types.js";

const KEYS = ["startLine", "startColumn", "endLine", "endColumn"] as const;

function asLocation(v: unknown, path: string): SourceLocation | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.path !== path) return undefined;
  const out: { path: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number } = { path };
  for (const k of KEYS) {
    const n = o[k];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isInteger(n)) return undefined;
    out[k] = n;
  }
  return out.startLine === undefined ? undefined : out;
}

const start = (l: SourceLocation) => [l.startLine ?? 0, l.startColumn ?? 0] as const;
const end = (l: SourceLocation) => [l.endLine ?? l.startLine ?? 0, l.endColumn ?? Number.MAX_SAFE_INTEGER] as const;
const le = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);

/** inner lies within outer (same file). */
function within(inner: SourceLocation, outer: SourceLocation): boolean {
  return le(start(outer), start(inner)) && le(end(inner), end(outer));
}

export function nodeLocations(node: Pick<GraphNode, "source" | "payload">): SourceLocation[] {
  const primary = node.source;
  if (primary === undefined) return [];
  const extra = node.payload.additionalLocations;
  if (!Array.isArray(extra) || extra.length === 0) return [primary];
  const all = [primary, ...extra.map((x) => asLocation(x, primary.path)).filter((x): x is SourceLocation => x !== undefined)]
    .sort(compareSourceLocations);
  const unique = all.filter((l, i) => i === 0 || compareSourceLocations(all[i - 1] as SourceLocation, l) !== 0);
  return unique.filter((l) => !unique.some((o) => o !== l && within(l, o) && compareSourceLocations(l, o) !== 0));
}

