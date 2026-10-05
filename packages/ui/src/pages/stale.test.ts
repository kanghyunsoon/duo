/** T34.3: the UI says "not applicable" for a YAML Decision and never mixes it with a checked "no". */
import { describe, expect, it } from "vitest";
import { proposerText, staleText } from "./decisions.js";

describe("staleText (same meaning as duoctl decision confirm)", () => {
  it("proposal: no, or yes with what changed; decision: not applicable", () => {
    expect(staleText({ sourceKind: "proposal" })).toBe("no");
    expect(staleText({ sourceKind: "proposal", stale: { truthChanged: true, changedRefs: ["AUTH-01"] } })).toBe("yes, Project Truth changed since this proposal was made (changed: AUTH-01)");
    expect(staleText({ sourceKind: "decision" })).toBe("not applicable (staleness is tracked for proposals only)");
  });

  it("H-71 proposer as the CLI shows it, never invented", () => {
    expect(proposerText({ proposedBy: "codex", proposedByKind: "agent" })).toBe("codex (agent)");
    expect(proposerText({ proposedBy: "codex" })).toBe("codex");
    expect(proposerText({})).toBe("(not set)");
  });
});
