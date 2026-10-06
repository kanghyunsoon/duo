/**
 * Human-facing provenance wording (H-73, C240). Formatting only: the machine values in ReviewResult
 * JSON, Review Records and MCP structuredContent stay "introduced", "pre-existing",
 * "pre-existing-touched" and "unverified-at-adoption" with their meaning unchanged.
 *
 * "introduced" means the violation key is absent from the Adoption Baseline and that baseline could
 * evaluate it. It does not say this diff created the relation, import or dependency, and Git history
 * does not prove when it appeared. The labels therefore name the baseline fact, never a time in the
 * current diff. Every human renderer (CLI review text, MCP text summary, Web UI) uses this one table;
 * the UI keeps a copy that a test holds equal to it (the UI may import core types only).
 */
import type { ViolationProvenance } from "../adoption/types.js";

export type ProvenanceLocale = "en" | "ko";

export const PROVENANCE_LABELS: Readonly<Record<ProvenanceLocale, Readonly<Record<ViolationProvenance, string>>>> = {
  en: {
    introduced: "not-in-adoption-baseline",
    "pre-existing": "in-adoption-baseline",
    "pre-existing-touched": "in-adoption-baseline, touched",
    "unverified-at-adoption": "baseline-unverified",
  },
  ko: {
    introduced: "채택 기준선에 없음",
    "pre-existing": "채택 기준선에 존재",
    "pre-existing-touched": "채택 기준선에 존재, 이번 변경에서 접촉",
    "unverified-at-adoption": "채택 시점 검증 불가",
  },
};

/** The words a person reads for a claim's provenance. Same value + locale → same text. */
export function provenanceLabel(value: ViolationProvenance, locale: ProvenanceLocale = "en"): string {
  return PROVENANCE_LABELS[locale][value];
}
