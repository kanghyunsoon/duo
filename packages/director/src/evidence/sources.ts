/**
 * Built-in evidence sources (TASK-013). Each builder returns the ID of an Evidence item in the
 * store. Content is addressed by hash: Project Truth by its exact definition slice (T09.1), the
 * repository by a symbol, test or file slice, Git by the lines of one hunk, a test run by its
 * reported result. Pointers keep IDs, paths, line ranges and hashes only, never the content.
 */
import {
  canonicalSourceText, evidenceId, nodeId, sha256Text, sliceSource, type EntityRef, type EvidenceKind, type RepoPath, type SourceLocation,
} from "@duo-director/core";
import type { GraphNode } from "@duo-director/graph";
import type { SourceReader } from "../context/retrieve.js";
import type { EvidenceStore } from "./store.js";

const lines = (loc: SourceLocation | undefined): readonly [number, number] | undefined =>
  loc?.startLine === undefined ? undefined : [loc.startLine, loc.endLine ?? loc.startLine];

export interface TruthItem {
  readonly kind: "requirement" | "decision" | "constraint" | "issue" | "milestone";
  readonly id: string;
  readonly title: string;
  readonly location: SourceLocation;
}

/** An exact Project Truth definition slice (current checkout). Undefined when the slice cannot be read exactly. */
export function truthEvidence(store: EvidenceStore, reader: SourceReader, item: TruthItem): string | undefined {
  const slice = reader.slice(item.location);
  if (slice.value === undefined) return undefined;
  return truthEvidenceOf(store, item, slice.value, "current");
}

/** A definition slice from another revision (the old side of a diff), given its file text. */
export function truthEvidenceFromText(store: EvidenceStore, item: TruthItem, fileText: string, side: string): string | undefined {
  const slice = sliceSource(canonicalSourceText(fileText), item.location);
  return slice.value === undefined ? undefined : truthEvidenceOf(store, item, slice.value, side);
}

function truthEvidenceOf(store: EvidenceStore, item: TruthItem, text: string, side: string): string {
  const contentHash = sha256Text(text);
  const type = item.kind === "constraint" ? "decision" : item.kind;
  const entity: EntityRef = { type, id: item.id };
  return store.add({
    id: evidenceId("project-truth", item.kind, `${item.id}\n${contentHash}`), basis: "project-truth", kind: item.kind, entity, source: item.location,
    contentHash, summary: `${item.id} ${item.title}`,
    pointer: { kind: item.kind, id: item.id, path: item.location.path as RepoPath, ...(lines(item.location) === undefined ? {} : { lines: lines(item.location) }), contentHash },
    ...(side === "current" ? {} : { metadata: { side } }),
  }, text);
}

/** A symbol, test or file of the current repository state (a file is referenced, not copied). */
export function repositoryEvidence(store: EvidenceStore, reader: SourceReader, node: GraphNode, commit: string): string | undefined {
  const ref = node.ref;
  if (ref.type !== "symbol" && ref.type !== "test" && ref.type !== "file") return undefined;
  let text: string | undefined;
  if (node.source !== undefined && ref.type !== "file") {
    const slice = reader.slice(node.source);
    if (slice.value === undefined) return undefined;
    text = slice.value;
  } else {
    text = reader.text(ref.path).value;
  }
  if (text === undefined) return undefined;
  const contentHash = sha256Text(text);
  const kind: EvidenceKind = ref.type;
  const name = ref.type === "symbol" ? ref.symbol : ref.type === "test" ? ref.name : undefined;
  return store.add({
    id: evidenceId("repository", kind, `${nodeId(ref)}\n${contentHash}`), basis: "repository", kind, entity: ref,
    ...(node.source === undefined ? {} : { source: node.source }), contentHash, summary: name === undefined ? ref.path : `${ref.path}#${name}`,
    pointer: {
      kind, path: ref.path, ...(name === undefined ? {} : { symbol: name }), ...(ref.type !== "file" && lines(node.source) !== undefined ? { lines: lines(node.source) } : {}),
      commit, contentHash,
    },
  }, ref.type === "file" ? undefined : text);
}

export interface HunkInput {
  readonly path: string;
  readonly oldPath?: string;
  readonly change: "added" | "modified" | "removed";
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
  readonly oldOid?: string;
  readonly newOid?: string;
}

/** One diff hunk. Identity: path, old path and the hunk's lines (not its position). */
export function hunkEvidence(store: EvidenceStore, h: HunkInput, to: string): string {
  const contentHash = sha256Text(h.lines.join("\n"));
  const range: readonly [number, number] = h.newLines > 0 ? [h.newStart, h.newStart + h.newLines - 1] : [h.oldStart, h.oldStart + Math.max(0, h.oldLines - 1)];
  return store.add({
    id: evidenceId("git", "diff", `${h.path}\n${h.oldPath ?? ""}\n${contentHash}`), basis: "git", kind: "diff",
    contentHash, summary: `${h.path} @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`,
    pointer: { kind: "diff", path: h.path as RepoPath, lines: range, change: h.change, commit: to, contentHash },
    metadata: {
      oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines,
      ...(h.oldPath === undefined ? {} : { oldPath: h.oldPath }), ...(h.oldOid === undefined ? {} : { oldBlob: h.oldOid }), ...(h.newOid === undefined ? {} : { newBlob: h.newOid }),
    },
  }, h.lines.join("\n"));
}

/** A change without hunks (deleted or binary file, pure rename, mode change). */
export function changeEvidence(store: EvidenceStore, c: { readonly path: string; readonly oldPath?: string; readonly kind: string; readonly oldOid?: string; readonly newOid?: string; readonly similarity?: number; readonly binary: boolean }, to: string): string {
  const key = [c.path, c.oldPath ?? "", c.kind, c.oldOid ?? "", c.newOid ?? ""].join("\n");
  const change = c.kind === "deleted" ? "removed" : c.kind === "added" || c.kind === "untracked" ? "added" : "modified";
  return store.add({
    id: evidenceId("git", "diff", key), basis: "git", kind: "diff", summary: `${c.kind} ${c.oldPath === undefined ? "" : `${c.oldPath} → `}${c.path}`,
    pointer: { kind: "diff", path: c.path as RepoPath, change, commit: to },
    metadata: {
      change: c.kind, binary: c.binary, ...(c.oldPath === undefined ? {} : { oldPath: c.oldPath }), ...(c.similarity === undefined ? {} : { similarity: c.similarity }),
      ...(c.oldOid === undefined ? {} : { oldBlob: c.oldOid }), ...(c.newOid === undefined ? {} : { newBlob: c.newOid }),
    },
  });
}

/** A test result reported by the caller. Review never runs tests; a Test node is not a passing test. */
export function testRunEvidence(store: EvidenceStore, run: { readonly command?: string; readonly status: string }, test: { readonly path?: string; readonly name: string; readonly status: string } | undefined): string {
  const key = [run.command ?? "", test?.path ?? "", test?.name ?? "(run)", test?.status ?? run.status].join("\n");
  const status = test?.status ?? run.status;
  return store.add({
    id: evidenceId("test", "test", key), basis: "test", kind: "test", contentHash: sha256Text(key),
    summary: `${test === undefined ? "test run" : test.name}: ${status}`,
    pointer: { kind: "test", ...(test?.path === undefined ? {} : { path: test.path as RepoPath }), ...(test === undefined ? {} : { symbol: test.name }) },
    metadata: { status, ...(run.command === undefined ? {} : { command: run.command }) },
  });
}
