/**
 * H-73 (C240): the Web UI keeps its own copy of the provenance wording because it imports core types
 * only (ADR-010 boundaries). This holds that copy equal to the one table the CLI and MCP text use.
 */
import { PROVENANCE_LABELS } from "@duo-director/director";
import { describe, expect, it } from "vitest";
import { PROVENANCE_BADGES } from "../../packages/ui/src/provenance.js";

describe("UI provenance badges use the shared human wording (H-73)", () => {
  it("every machine provenance value has the same label in the UI as in CLI and MCP text", () => {
    for (const [value, label] of Object.entries(PROVENANCE_LABELS.en)) expect(PROVENANCE_BADGES[value]?.text).toBe(label);
  });

  it("no UI badge or help text says the change introduced or newly added a violation", () => {
    for (const value of Object.keys(PROVENANCE_LABELS.en)) {
      const badge = PROVENANCE_BADGES[value];
      expect(badge?.text).not.toMatch(/introduc/iu);
      expect(badge?.help).not.toMatch(/introduc|new since|newly/iu);
    }
  });
});
