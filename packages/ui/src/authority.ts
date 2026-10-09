/**
 * Decision lifecycle wording in a live Review (C241, T49). The text is the shared human wording of
 * @duo-director/director AUTHORITY_LABELS.en and decisionAuthorityParts (tests/ui/authority-labels.test.ts holds
 * them equal; the UI imports core types only, so it keeps this copy). The API payload keeps decisionAuthority
 * as Project Truth has it; "current authority" means confirmed and not superseded, the rules' own test.
 */
import type { DecisionAuthority } from "./types.js";

export const AUTHORITY_TEXT = {
  current: "current authority", superseded: "superseded", inactive: "not current authority ({state})", supersedes: "supersedes {id}", supersededBy: "superseded by {id}",
} as const;

export function authorityParts(a: DecisionAuthority): string[] {
  return [
    a.active ? AUTHORITY_TEXT.current : a.state === "superseded" ? AUTHORITY_TEXT.superseded : AUTHORITY_TEXT.inactive.replace("{state}", a.state),
    ...(a.supersedes === null ? [] : [AUTHORITY_TEXT.supersedes.replace("{id}", a.supersedes)]),
    ...(a.supersededBy === null ? [] : [AUTHORITY_TEXT.supersededBy.replace("{id}", a.supersededBy)]),
  ];
}
