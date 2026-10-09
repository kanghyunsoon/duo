/**
 * C241 (T49): the Web UI keeps its own copy of the Decision lifecycle wording because it imports core types only
 * (ADR-010 boundaries). This holds that copy equal to the one table the CLI and MCP text use.
 */
import { AUTHORITY_LABELS, decisionAuthorityLabel } from "@duo-director/director";
import { describe, expect, it } from "vitest";
import { AUTHORITY_TEXT, authorityParts } from "../../packages/ui/src/authority.js";

describe("UI Decision lifecycle wording is the shared human wording (C241)", () => {
  it("the UI table is AUTHORITY_LABELS.en", () => {
    expect(AUTHORITY_TEXT).toEqual(AUTHORITY_LABELS.en);
  });

  it("every lifecycle shape renders the same text in the UI as in CLI and MCP text", () => {
    const shapes = [
      { state: "confirmed", active: true, supersedes: null, supersededBy: null },
      { state: "confirmed", active: true, supersedes: "D-001", supersededBy: null },
      { state: "superseded", active: false, supersedes: null, supersededBy: "D-002" },
      { state: "superseded", active: false, supersedes: "D-001", supersededBy: "D-003" },
      { state: "confirmed", active: false, supersedes: null, supersededBy: "D-005" },
      { state: "proposed", active: false, supersedes: null, supersededBy: null },
    ] as const;
    for (const a of shapes) expect(authorityParts(a).join(" · ")).toBe(decisionAuthorityLabel(a));
  });
});
