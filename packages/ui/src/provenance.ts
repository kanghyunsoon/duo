/**
 * Provenance badges (H-73, C240). The text is the shared human wording of
 * @duo-director/director PROVENANCE_LABELS.en (tests/ui/provenance-labels.test.ts holds them equal;
 * the UI imports core types only, so it keeps this copy). Machine values in the API payload are
 * unchanged: "introduced" means absent from the Adoption Baseline, not created by this change.
 */
export type BadgeTone = "ok" | "info" | "warn" | "muted" | "block";

export const PROVENANCE_BADGES: Readonly<Record<string, { readonly text: string; readonly tone: BadgeTone; readonly help: string }>> = {
  introduced: { text: "not-in-adoption-baseline", tone: "block", help: "not in the Adoption Baseline, which could evaluate it; this does not say the change created it" },
  "pre-existing": { text: "in-adoption-baseline", tone: "muted", help: "in the Adoption Baseline and not touched by this change: history, not a new violation" },
  "pre-existing-touched": { text: "in-adoption-baseline, touched", tone: "warn", help: "in the Adoption Baseline and this change touches it: a warning, never a block" },
  "unverified-at-adoption": { text: "baseline-unverified", tone: "warn", help: "the Adoption Baseline could not evaluate this violation: a warning, never a block" },
  "adoption-bootstrap": { text: "adoption bootstrap", tone: "muted", help: "Truth files exactly as init wrote them: not reviewed until changed" },
};
