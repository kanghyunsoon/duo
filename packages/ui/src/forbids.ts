/**
 * T40 (N3): governs does not scope forbids. The same words as the CLI confirm preview
 * (apps/cli messages "decision.preview.forbids-scope"; tests/ui/forbids-scope.test.ts holds them equal).
 */
export const FORBIDS_SCOPE = "repository-wide (governs does not narrow forbids)";

/** True when forbids has at least one entry. */
export function hasForbids(forbids: unknown): boolean {
  return typeof forbids === "object" && forbids !== null && Object.values(forbids as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
}
