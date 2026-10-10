/** H-80 (C239): the Review screen shows a PASS and its surfaced missing-intent gap together, with the PASS meaning. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../types.js";
import { PASS_MEANING, ReviewView } from "./review.js";

const passWithGap: ReviewResult = {
  status: "ready", verdict: "PASS", baseline: { status: "present", id: "adoption-0000000000000000" },
  diff: { identity: "diff", from: "b9beaa7", to: "WORKTREE", files: [{ path: "src/auth/token.ts", kind: "modified" }] },
  claims: [], evidence: [],
  gaps: { requiresHumanInput: false, gaps: [{ id: "rgap-1", kind: "missing-intent", action: "surface", relevance: "direct" }] },
  limitations: [], metrics: { llmCalls: 0 },
  semanticAssist: { status: "not-requested", claims: [], calls: 0, cacheHits: 0, skippedChecks: [] },
};

describe("Review screen: PASS with a surfaced missing-intent gap", () => {
  it("shows the PASS verdict, what PASS means, and the gap under Knowledge gaps", () => {
    const html = renderToStaticMarkup(<ReviewView r={passWithGap} />);
    expect(html).toContain("Deterministic review:");
    expect(html).toMatch(/>PASS</u);
    expect(html).toContain(PASS_MEANING);
    const gaps = html.slice(html.indexOf("Knowledge gaps"));
    expect(gaps).toContain("SURFACE");
    expect(gaps).toContain("missing-intent");
    expect(gaps).not.toContain("No gap needs attention.");
  });
});
