import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Level, Provenance, Verdict } from "./components.js";
import { route } from "./app.js";
import { CoverageTable } from "./pages/coverage.js";
import { DecisionLabel } from "./pages/direction.js";
import { llmText } from "./pages/overview.js";
import { PASS_MEANING, ReviewView } from "./pages/review.js";
import type { Overview, ReviewResult } from "./types.js";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("UI components (T18.1)", () => {
  it("verdicts carry text, never color alone", () => {
    for (const v of ["PASS", "WARN", "ASK", "BLOCK"]) expect(html(<Verdict verdict={v} />)).toContain(`>${v}<`);
  });

  it("baseline provenance values look different, and pre-existing is not a block", () => {
    const out = ["introduced", "pre-existing", "pre-existing-touched", "unverified-at-adoption", "adoption-bootstrap"].map((p) => html(<Provenance value={p} />));
    expect(new Set(out).size).toBe(5);
    expect(out[0]).toContain("tone-block");
    expect(out[1]).toContain("tone-muted");
    expect(out[1]).not.toContain("block");
    expect(out[2]).toContain("tone-warn");
    expect(out[3]).toContain("tone-warn");
    // H-73 (C240): adoption-baseline wording, never "introduced".
    expect(out.slice(0, 4).map((h) => /title="[^"]*">([^<]*)</u.exec(h)?.[1])).toEqual(["not-in-adoption-baseline", "in-adoption-baseline", "in-adoption-baseline, touched", "baseline-unverified"]);
    expect(out.join("")).not.toMatch(/introduced/u);
  });

  it("L0 is file-level analysis, not an error", () => {
    const l0 = html(<Level level="L0" />);
    expect(l0).toContain("L0 · file-level analysis");
    expect(l0).not.toMatch(/error|unsupported|broken/u);
    const table = html(<CoverageTable analysis={{
      analyzerRegistryDigest: "sha256:x", files: { total: 5, structural: 3, fileOnly: 2 },
      languages: [{ language: "java", files: 3, analyzer: "java", level: "L1", symbols: "structural", tests: "structural", imports: "syntactic", calls: "syntactic", typeResolution: "none" }],
      fileOnly: { level: "L0", files: 2, extensions: [{ extension: "kt", files: 2 }] },
    }} />);
    expect(table).toContain("L1 · structural");
    expect(table).toContain(".kt 2");
    expect(table).toContain("File-level analysis");
  });

  it("decision labels keep proposals and superseded Decisions apart from confirmed ones", () => {
    const labels = (["CONFIRMED", "PROPOSED", "SUPERSEDED", "REJECTED"] as const).map((l) => html(<DecisionLabel label={l} />));
    expect(labels.map((x) => />([A-Z]+)</u.exec(x)?.[1])).toEqual(["CONFIRMED", "PROPOSED", "SUPERSEDED", "REJECTED"]);
  });

  it("LLM disabled is a plain state; unavailable names the reason without alarming", () => {
    const status = (llm: string, extra = {}) => ({ llm, ...extra }) as unknown as Overview["status"];
    expect(llmText(status("disabled"))).toMatchObject({ tone: "muted" });
    expect(llmText(status("unavailable", { llmProvider: { provider: "openai-responses", status: "unavailable", reason: "OPENAI_API_KEY is not set" } })).text).toBe("Semantic assistance unavailable · OPENAI_API_KEY is not set");
  });

  it("a review shows the PASS meaning, keeps semantic assistance in its own section and points to --record", () => {
    const base: ReviewResult = {
      status: "ready", verdict: "PASS", baseline: { status: "present" }, diff: { identity: "sha256:d", from: "HEAD", to: "WORKTREE", files: [] },
      claims: [{ id: "claim-1", rule: "decision-forbids", subject: { kind: "decision", id: "D-004" }, alignment: "CONFLICT", reason: "forbidden-symbol", evidenceIds: [], basis: [], blockEligible: false, drift: false, provenance: "pre-existing-touched" }],
      evidence: [], limitations: [], metrics: { llmCalls: 1 },
      semanticAssist: { status: "success", calls: 1, cacheHits: 0, claims: [{ claimId: "claim-1", alignment: "CONFLICT", reason: "LLMWORDS", evidenceIds: [] }], verdict: "WARN", skippedChecks: [] },
    };
    const out = html(<ReviewView r={base} />);
    expect(out).toContain(PASS_MEANING);
    expect(out).not.toMatch(/100% aligned|All tests pass|Bug free/u);
    expect(out).toContain("Semantic assistance (supplemental, never blocks)");
    expect(out.indexOf("Semantic assistance")).toBeGreaterThan(out.indexOf("Claims"));
    expect(out).toContain("in-adoption-baseline, touched");
    expect(out).toContain("duoctl review --record");
    const stale = html(<ReviewView r={{ ...base, status: "index-required", freshness: { status: "stale" } }} />);
    expect(stale).toContain("index-required");
    expect(stale).toContain("duoctl index");
  });

  it("deep links route to their screens", () => {
    expect(html(route("/entity/AUTH-03"))).toContain("AUTH-03");
    expect(html(route("/decisions"))).toContain("Pending decisions");
    expect(html(route("/coverage"))).toContain("Analysis coverage");
  });
});
