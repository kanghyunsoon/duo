/**
 * #59 C259 (H-100): the duo_review_changes summary marks an informational claim with [information], as the CLI does.
 */
import { describe, expect, it } from "vitest";
import { TOOLS } from "./tools.js";

const claim = (id: string, extra: Record<string, unknown> = {}) => ({
  id, rule: "requirement-implementation", subject: { kind: "file", id: "src/name.ts" }, expected: "e", observed: "REQ-001, REQ-003", alignment: "PARTIAL",
  evidenceIds: ["ev-1"], basis: ["project-truth"], reason: "outside-current-milestone", enforced: false, blockEligible: false, drift: false, semanticCandidate: false,
  ...extra,
});

describe("duo_review_changes summary and informational claims (H-100)", () => {
  it("tags an informational claim [information] and leaves the other claims untagged", () => {
    const result = {
      format: "duo.review/1", status: "ready", verdict: "WARN",
      claims: [claim("claim-info", { informational: true }), claim("claim-test", { rule: "test-coverage", subject: { kind: "requirement", id: "REQ-001" }, reason: "untested-change" })],
      semanticAssist: { status: "not-requested", claims: [] }, metrics: { llmCalls: 0 },
    };
    const lines = TOOLS.duo_review_changes.summarize(result).split("\n");
    expect(lines).toContain("- PARTIAL requirement-implementation src/name.ts: outside-current-milestone [information]");
    expect(lines).toContain("- PARTIAL test-coverage REQ-001: untested-change");
  });
});
