/**
 * Diff seed resolution (TASK-013, C85): the Graph entities a diff touches become explicit Context
 * seeds. Priority: changed Symbol or Test (a hunk overlaps one of its current ranges; the innermost one
 * when ranges nest), else the changed File, and Truth definitions whose section a hunk touches. Overlap
 * is not ownership: a seed says "these lines changed inside this entity", nothing more.
 * A Symbol's ranges are all its locations (T24.1, C217): a hunk in a merged overload seeds that
 * Symbol, not the enclosing class.
 * Deleted files have no current node; they stay git evidence (deleted-unresolved limitation).
 */
import { compareUtf8, definitionRef, fileRef, nodeId, STATE_DIR_NAME, type EntityRef, type ProjectTruth, type SourceLocation } from "@duo-director/core";
import { nodeLocations, type GraphNode, type GraphReader } from "@duo-director/graph";
import { displayRef } from "../context/expand.js";
import type { ChangedFile, ChangedHunk, DiffSeed } from "./types.js";

const PROPOSALS = `${STATE_DIR_NAME}/decisions/proposals/`;

/** New-side line range a hunk touches; a pure deletion touches the line it follows. */
export function hunkRange(h: ChangedHunk): readonly [number, number] {
  return h.newLines > 0 ? [h.newStart, h.newStart + h.newLines - 1] : [Math.max(1, h.newStart), Math.max(1, h.newStart)];
}

export function overlaps(loc: SourceLocation | undefined, range: readonly [number, number]): boolean {
  if (loc?.startLine === undefined) return false;
  const end = loc.endLine ?? loc.startLine;
  return range[0] <= end && range[1] >= loc.startLine;
}

function owned(graph: GraphReader, path: ChangedFile["path"]): GraphNode[] {
  const out: GraphNode[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = graph.listNodes({ ownerFile: path, limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
    out.push(...page);
    if (page.length < 1000) return out;
    afterId = page[page.length - 1]?.id;
  }
}

const width = (loc: SourceLocation | undefined) => (loc?.endLine ?? 0) - (loc?.startLine ?? 0);

function truthDefinitions(truth: ProjectTruth): { ref: EntityRef; location: SourceLocation }[] {
  return [
    ...truth.requirements.map((d) => ({ ref: definitionRef("requirement", d.id), location: d.location })),
    ...truth.decisions.map((d) => ({ ref: definitionRef("decision", d.id), location: d.location })),
    ...truth.constraints.map((d) => ({ ref: definitionRef("decision", d.id), location: d.location })),
    ...truth.issues.map((d) => ({ ref: definitionRef("issue", d.id), location: d.location })),
    ...truth.milestones.map((d) => ({ ref: definitionRef("milestone", d.id), location: d.location })),
  ];
}

export function diffSeeds(files: readonly ChangedFile[], graph: GraphReader, truth: ProjectTruth): DiffSeed[] {
  const seeds = new Map<string, { entity: EntityRef; reason: DiffSeed["reason"]; path: ChangedFile["path"]; evidence: Set<string> }>();
  const put = (entity: EntityRef, reason: DiffSeed["reason"], path: ChangedFile["path"], evidenceId: string) => {
    if (graph.getNode(entity) === undefined) return;
    const id = nodeId(entity);
    const s = seeds.get(id) ?? { entity, reason, path, evidence: new Set<string>() };
    s.evidence.add(evidenceId);
    seeds.set(id, s);
  };
  const defs = truthDefinitions(truth);
  for (const f of files) {
    if (f.kind === "deleted") continue;
    if (f.path.startsWith(`${STATE_DIR_NAME}/`)) {
      if (f.path.startsWith(PROPOSALS)) continue; // proposals are not Project Truth
      for (const h of f.hunks) {
        for (const d of defs) if (d.location.path === f.path && overlaps(d.location, hunkRange(h))) put(d.ref, "truth-changed", f.path, h.evidenceId);
      }
      continue;
    }
    const nodes = owned(graph, f.path).filter((n) => n.type === "symbol" || n.type === "test");
    const ranges = new Map(nodes.map((n) => [n.id, nodeLocations(n)] as const));
    let touched = false;
    for (const h of f.hunks) {
      const range = hunkRange(h);
      // The ranges of each node the hunk overlaps (one per node unless a Symbol has several locations).
      const hits = nodes.map((n) => ({ n, at: (ranges.get(n.id) ?? []).filter((l) => overlaps(l, range)) })).filter((x) => x.at.length > 0);
      // Innermost: a hunk inside a method seeds the method, not also its class.
      const inner = hits.filter((x) => !hits.some((o) => o !== x
        && o.at.some((ol) => x.at.some((xl) => width(ol) < width(xl) && overlaps(xl, [ol.startLine ?? 0, ol.endLine ?? 0])))));
      for (const { n } of inner) { put(n.ref, "hunk-overlap", f.path, h.evidenceId); touched = true; }
    }
    if (!touched) for (const e of f.evidenceIds) put(fileRef(f.path), "file-changed", f.path, e);
  }
  return [...seeds.entries()].sort(([a], [b]) => compareUtf8(a, b)).map(([id, s]) => ({
    id, ref: displayRef(id), entity: s.entity, reason: s.reason, path: s.path, evidenceIds: [...s.evidence].sort(compareUtf8),
  }));
}
