/**
 * Evidence data contract (TASK-013, C44). Neutral: core knows what a piece of evidence is, not how
 * it was fetched. Git, the Graph, Project Truth, caller-supplied test runs and (optionally) an LLM
 * are sources the director's Review collects from; a future Jira source fits the same shape.
 *
 * Identity is deterministic and content-based: basis + kind + a stable key (entity ID, path, content
 * hash), never a line number alone and never the time of collection.
 */
import { createHash } from "node:crypto";
import type { SourceLocation } from "./diagnostics.js";
import type { EvidencePointer, EvidenceKind } from "./domain/model.js";
import type { EntityRef } from "./ids.js";

/**
 * project-truth: an exact Requirement / Decision / Constraint slice. repository: current source
 * (symbol, file). git: a diff hunk or change record. test: a caller-supplied test run result.
 * llm: a provider's answer (never observable evidence).
 */
export type EvidenceBasis = "project-truth" | "repository" | "git" | "test" | "llm";

export type EvidenceMetadataValue = string | number | boolean | null | readonly string[];

export interface Evidence {
  readonly id: string;
  readonly basis: EvidenceBasis;
  readonly kind: EvidenceKind;
  readonly entity?: EntityRef;
  readonly source?: SourceLocation;
  /** sha256 of the exact content this evidence stands for (slice, hunk lines, test result). */
  readonly contentHash?: string;
  readonly summary?: string;
  /** The pointer a recorded Review keeps instead of the content (ADR-006, AC-013-05). */
  readonly pointer: EvidencePointer;
  readonly metadata?: Readonly<Record<string, EvidenceMetadataValue>>;
}

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** "ev-" + 16 hex of sha256(basis, kind, key). The key must not depend on line numbers alone. */
export function evidenceId(basis: EvidenceBasis, kind: EvidenceKind, key: string): string {
  return `ev-${createHash("sha256").update(`${basis}\n${kind}\n${key}`).digest("hex").slice(0, 16)}`;
}
