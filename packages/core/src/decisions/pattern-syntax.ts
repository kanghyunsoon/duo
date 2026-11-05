/**
 * H-104 (#165): one syntax check for Decision path patterns (governs.paths, forbids.paths, forbids.imported_paths,
 * forbids.importer_paths), shared by propose, confirm, the Project Truth loader, status, doctor and review.
 *
 * New input is refused: a proposal with an unsupported pattern is not written (PROPOSAL_INVALID), and a confirm
 * that would write one is refused. A confirmed Decision that already has one keeps loading unchanged (file and lock
 * digest are not touched); status, doctor and review name it, because the pattern matches no file and is not checked.
 * The matcher (compileRepoPattern) is unchanged.
 */
import { createDiagnostic, withSeverity, type Diagnostic, type SourceLocation } from "../diagnostics.js";
import type { ProjectTruth } from "../domain/model.js";
import { compareUtf8 } from "../order.js";
import { REPO_PATTERN_SYNTAX, unsupportedPatternSyntax } from "../paths.js";

/** One unsupported pattern of a confirmed Decision. */
export interface UnsupportedDecisionPattern {
  readonly decision: string;
  /** The field as the Decision file spells it, e.g. forbids.paths. */
  readonly field: string;
  readonly pattern: string;
  readonly reason: string;
}

const strings = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const objectAt = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined);

/** The pattern fields of a candidate as a proposal input or a Decision file spells them (snake_case). */
function candidateFields(candidate: unknown): [string, readonly string[]][] {
  const governs = objectAt(candidate, "governs");
  const forbids = objectAt(candidate, "forbids");
  return [
    ["governs.paths", strings(objectAt(governs, "paths"))],
    ["forbids.paths", strings(objectAt(forbids, "paths"))],
    ["forbids.imported_paths", strings(objectAt(forbids, "imported_paths"))],
    ["forbids.importer_paths", strings(objectAt(forbids, "importer_paths"))],
  ];
}

/** The message for new input (propose, confirm). */
export function unsupportedPatternMessage(field: string, pattern: string, reason: string): string {
  return `${field} pattern "${pattern}" uses unsupported syntax: ${reason}. ${REPO_PATTERN_SYNTAX}`;
}

/** New input (propose, confirm): one error per unsupported pattern, naming the field and the pattern. */
export function candidatePatternErrors(candidate: unknown, location?: SourceLocation): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [field, values] of candidateFields(candidate)) {
    for (const pattern of values) {
      const reason = unsupportedPatternSyntax(pattern);
      if (reason !== undefined) out.push(withSeverity(createDiagnostic("PATTERN_SYNTAX_UNSUPPORTED", unsupportedPatternMessage(field, pattern, reason), location), "error"));
    }
  }
  return out;
}

/** Confirmed Decisions (the ones review applies) with an unsupported pattern, by Decision ID and field order. */
export function unsupportedDecisionPatterns(truth: Pick<ProjectTruth, "decisions">): UnsupportedDecisionPattern[] {
  const out: UnsupportedDecisionPattern[] = [];
  for (const d of [...truth.decisions].filter((x) => x.state === "confirmed").sort((a, b) => compareUtf8(a.id, b.id))) {
    const fields: [string, readonly string[]][] = [
      ["governs.paths", d.governs.paths], ["forbids.paths", d.forbids.paths],
      ["forbids.imported_paths", d.forbids.importedPaths ?? []], ["forbids.importer_paths", d.forbids.importerPaths ?? []],
    ];
    for (const [field, values] of fields) {
      for (const pattern of values) {
        const reason = unsupportedPatternSyntax(pattern);
        if (reason !== undefined) out.push({ decision: d.id, field, pattern, reason });
      }
    }
  }
  return out;
}
