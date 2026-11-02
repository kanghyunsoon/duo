/**
 * T40 (N3): the Web UI states the forbids scope in the same words as the CLI confirm preview.
 */
import { describe, expect, it } from "vitest";
import { t } from "../../apps/cli/src/messages.js";
import { FORBIDS_SCOPE, FORBIDS_SCOPE_IMPORTERS, forbidsScope, hasForbids } from "../../packages/ui/src/forbids.js";

describe("forbids scope wording (T40 N3)", () => {
  it("UI and CLI say the same thing", () => {
    expect(FORBIDS_SCOPE).toBe(t("en", "decision.preview.forbids-scope"));
    expect(FORBIDS_SCOPE).toContain("repository-wide");
    expect(FORBIDS_SCOPE_IMPORTERS).toBe(t("en", "decision.preview.forbids-scope-importers"));
  });
  it("#47: importer_paths changes the scope row; without it the row stays repository-wide", () => {
    expect(forbidsScope({ imported_paths: ["src/db/legacy-db.ts"], importer_paths: ["src/ui/**"] })).toBe(FORBIDS_SCOPE_IMPORTERS);
    expect(forbidsScope({ imported_paths: ["src/db/legacy-db.ts"] })).toBe(FORBIDS_SCOPE);
    expect(forbidsScope({ imported_paths: ["src/db/legacy-db.ts"], importer_paths: [] })).toBe(FORBIDS_SCOPE);
  });
  it("the scope row is shown only when forbids has an entry", () => {
    expect(hasForbids({ imported_paths: ["src/db/legacy-db.ts"] })).toBe(true);
    expect(hasForbids({ paths: [] })).toBe(false);
    expect(hasForbids(undefined)).toBe(false);
  });
});
