/**
 * Authority boundary for Project Truth (T40, N1). loadProjectTruth() stays tolerant: it returns what it
 * could read plus every diagnostic, so status, doctor and the index can still describe a broken repository.
 * An operation that decides with Truth's authority (review, context, Adoption Baseline capture, the Decision
 * lifecycle) must not decide on part of it: a Decision the loader had to leave out would otherwise disappear
 * without a trace and a review could PASS. Those operations call requireCompleteTruth().
 *
 * Fail closed: every error-severity loader diagnostic blocks, including codes added later, except the two
 * reference-integrity codes that never remove content (a reference to an ID that is not defined, or to an
 * ID of the wrong type). Those keep every definition in place and are reported by trace and review rules.
 * Nothing here reads or writes files; the offending Truth file is never repaired or removed.
 */
import { createDiagnostic, type Diagnostic, type ParseResult } from "../diagnostics.js";
import type { LoadedProject } from "./project.js";

/** Error codes that do not remove or hide Truth content (the definitions are all loaded). */
export const NON_BLOCKING_TRUTH_ERRORS: ReadonlySet<string> = new Set(["BROKEN_REFERENCE", "REFERENCE_TYPE_MISMATCH"]);

/** The loader diagnostics that make Project Truth unusable for an authoritative decision. */
export function truthAuthorityErrors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error" && !NON_BLOCKING_TRUTH_ERRORS.has(d.code));
}

/** One summary diagnostic for the errors, naming the first file. */
export function projectTruthInvalid(errors: readonly Diagnostic[]): Diagnostic {
  const files = [...new Set(errors.map((e) => e.source?.path).filter((p): p is string => p !== undefined))];
  const where = files.length === 0 ? "" : `: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
  return createDiagnostic("PROJECT_TRUTH_INVALID",
    `Project Truth could not be read completely (${errors.length} error${errors.length === 1 ? "" : "s"}${where}). DUO does not review, compile context or change Decisions on partial Truth. Fix the file; DUO does not change it.`);
}

/**
 * The loaded Project Truth for an authoritative operation, or a failure with PROJECT_TRUTH_INVALID followed
 * by each blocking diagnostic (file and position). A not-initialized or unreadable project stays as it was.
 */
export function requireCompleteTruth(loaded: ParseResult<LoadedProject>): ParseResult<LoadedProject> {
  if (loaded.value === undefined) return loaded;
  const errors = truthAuthorityErrors(loaded.diagnostics);
  return errors.length === 0 ? loaded : { diagnostics: [projectTruthInvalid(errors), ...errors] };
}
