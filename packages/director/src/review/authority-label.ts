/**
 * Human-facing wording of a Decision claim's lifecycle (C241, T49). Formatting only: ReviewResult JSON and MCP
 * structuredContent keep decisionAuthority { state, active, supersedes, supersededBy } as Project Truth has it.
 * "current authority" is shown only when active (confirmed and not superseded, the rules' own test); the relations
 * are the Decision's direct fields, never a resolved chain. It explains which Decision the verdict used; it is not a
 * verdict signal. Every human renderer (CLI review text, MCP text summary, Web UI) uses this table; the UI keeps a
 * copy of the en entries that tests/ui/authority-labels.test.ts holds equal (the UI may import core types only).
 */
import type { ProvenanceLocale } from "./provenance-label.js";
import type { DecisionAuthority } from "./types.js";

export const AUTHORITY_LABELS = {
  en: { current: "current authority", superseded: "superseded", inactive: "not current authority ({state})", supersedes: "supersedes {id}", supersededBy: "superseded by {id}" },
  ko: { current: "현재 authority", superseded: "대체됨", inactive: "현재 authority 아님({state})", supersedes: "대체 대상 {id}", supersededBy: "대체한 Decision {id}" },
} as const satisfies Readonly<Record<ProvenanceLocale, Readonly<Record<"current" | "superseded" | "inactive" | "supersedes" | "supersededBy", string>>>>;

/** The lifecycle facts in reading order: authority, then supersedes, then superseded by. */
export function decisionAuthorityParts(a: DecisionAuthority, locale: ProvenanceLocale = "en"): string[] {
  const l = AUTHORITY_LABELS[locale];
  return [
    a.active ? l.current : a.state === "superseded" ? l.superseded : l.inactive.replace("{state}", a.state),
    ...(a.supersedes === null ? [] : [l.supersedes.replace("{id}", a.supersedes)]),
    ...(a.supersededBy === null ? [] : [l.supersededBy.replace("{id}", a.supersededBy)]),
  ];
}

/** One line: the parts joined with " · ". Same facts + locale → same text. */
export function decisionAuthorityLabel(a: DecisionAuthority, locale: ProvenanceLocale = "en"): string {
  return decisionAuthorityParts(a, locale).join(" · ");
}
