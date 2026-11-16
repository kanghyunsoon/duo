/**
 * T40 (N3): governs does not scope forbids. The same words as the CLI confirm preview
 * (apps/cli messages "decision.preview.forbids-scope"; tests/ui/forbids-scope.test.ts holds them equal).
 */
export const FORBIDS_SCOPE = "repository-wide (governs does not narrow forbids)";
/** #47: when forbids.importer_paths is set (apps/cli messages "decision.preview.forbids-scope-importers"). */
export const FORBIDS_SCOPE_IMPORTERS = "imported_paths only for importing files matching importer_paths; other forbids repository-wide (governs does not narrow forbids)";

/** The scope row for a forbids value: importer-scoped when importer_paths has an entry. */
export function forbidsScope(forbids: unknown): string {
  const importers = typeof forbids === "object" && forbids !== null ? (forbids as Record<string, unknown>)["importer_paths"] : undefined;
  return Array.isArray(importers) && importers.length > 0 ? FORBIDS_SCOPE_IMPORTERS : FORBIDS_SCOPE;
}

/** True when forbids has at least one entry. */
export function hasForbids(forbids: unknown): boolean {
  return typeof forbids === "object" && forbids !== null && Object.values(forbids as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
}
