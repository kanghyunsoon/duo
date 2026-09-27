/**
 * Lock digest and provenance digests for Decisions (ADR-013, T09). The lock digest is a mistake
 * detector over a Decision's content fields, not a signature: anyone can recompute it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR_NAME } from "../constants.js";
import { createDiagnostic, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import type { Decision, ProjectTruth } from "../domain/model.js";
import { sliceSourceLocation } from "../location.js";
import { compareUtf8 } from "../order.js";

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareUtf8)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** Canonical JSON: sorted keys, undefined dropped. */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

type LockContent = Pick<Decision, "title" | "decisionKind" | "question" | "answer" | "rationale" | "governs" | "forbids" | "enforcement" | "supersedes">;

/**
 * sha256 over the content fields (title, kind, question, answer, rationale, governs, forbids,
 * enforcement, supersedes). Lifecycle fields (state, superseded_by, confirmed_*, lock) are not
 * part of it, so marking a Decision superseded keeps its lock valid (AC-009-03).
 */
export function decisionLockDigest(d: LockContent): string {
  return sha256(stableJson({
    title: d.title, kind: d.decisionKind, question: d.question, answer: d.answer, rationale: d.rationale,
    governs: d.governs, forbids: d.forbids, enforcement: d.enforcement, supersedes: d.supersedes,
  }));
}

export type LockStatus = "valid" | "missing" | "mismatch" | "not-confirmed";

export interface LockVerification {
  readonly id: string;
  readonly status: LockStatus;
  readonly expected: string;
  readonly recorded?: string;
}

/** Checks a confirmed or superseded Decision's lock.digest against its content. */
export function verifyDecisionLock(d: Decision): { readonly value: LockVerification; readonly diagnostics: readonly Diagnostic[] } {
  const expected = decisionLockDigest(d);
  const base = { id: d.id, expected, ...(d.lock === undefined ? {} : { recorded: d.lock.digest }) };
  if (d.state !== "confirmed" && d.state !== "superseded") return { value: { ...base, status: "not-confirmed" }, diagnostics: [] };
  if (d.lock === undefined) return { value: { ...base, status: "missing" }, diagnostics: [] };
  if (d.lock.digest === expected) return { value: { ...base, status: "valid" }, diagnostics: [] };
  return {
    value: { ...base, status: "mismatch" },
    diagnostics: [createDiagnostic("DECISION_LOCK_MISMATCH", `${d.id}: lock.digest does not match its content (expected ${expected})`, d.location)],
  };
}

const PROPOSALS_PREFIX = `${STATE_DIR_NAME}/decisions/proposals/`;

/** sha256 over the Project Truth files the loader read (proposals excluded), content normalized to LF. */
export function truthDigest(root: string, truth: ProjectTruth): string {
  const parts: string[] = [];
  for (const file of [...truth.files].sort(compareUtf8)) {
    if (file.startsWith(PROPOSALS_PREFIX)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    } catch {
      text = "\u0000missing";
    }
    parts.push(`${file}\u0000${sha256(text)}`);
  }
  return sha256(parts.join("\n"));
}

/**
 * sha256 of a definition's source text: its exact SourceLocation slice, else the lines it spans
 * (clamped to the file), else the whole file. Undefined only when the file cannot be read.
 */
export function definitionDigest(root: string, location: SourceLocation): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, location.path), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
  const exact = sliceSourceLocation(text, location);
  if (exact !== undefined) return sha256(exact);
  if (location.startLine === undefined) return sha256(text);
  const lines = text.split("\n");
  return sha256(lines.slice(location.startLine - 1, location.endLine ?? lines.length).join("\n"));
}
