/**
 * T40 (N3): the Web UI states the forbids scope in the same words as the CLI confirm preview.
 */
import { describe, expect, it } from "vitest";
import { t } from "../../apps/cli/src/messages.js";
import { FORBIDS_SCOPE, hasForbids } from "../../packages/ui/src/forbids.js";

describe("forbids scope wording (T40 N3)", () => {
  it("UI and CLI say the same thing", () => {
    expect(FORBIDS_SCOPE).toBe(t("en", "decision.preview.forbids-scope"));
    expect(FORBIDS_SCOPE).toContain("repository-wide");
  });
  it("the scope row is shown only when forbids has an entry", () => {
    expect(hasForbids({ imported_paths: ["src/db/legacy-db.ts"] })).toBe(true);
    expect(hasForbids({ paths: [] })).toBe(false);
    expect(hasForbids(undefined)).toBe(false);
  });
});
