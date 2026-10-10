/**
 * C258 (T59): the missing-intent wording says what the signal means, that the context DUO assembled (Context packet
 * intent tier) has no confirmed Requirement or Decision intent. It does not speak of "this task" (a review may have
 * none) and does not deny that confirmed Decisions exist (review rules may still apply one). One sentence for both
 * reasons; the gap itself is not changed.
 */
import { describe, expect, it } from "vitest";
import { renderGapQuestion, renderGapQuestions } from "./render.js";
import type { GapReasonCode, KnowledgeGap, KnowledgeGapAssessment } from "./types.js";

const EN = "The context DUO assembled contains no confirmed Requirement or Decision intent.";
const KO = "DUO가 구성한 Context에 확정된 Requirement/Decision intent가 없습니다.";
const missing = (code: GapReasonCode): KnowledgeGap => ({ id: "rgap-" + code, source: "runtime", kind: "missing-intent", anchors: [], relevance: "direct", reasons: [{ code }], action: "surface" });
const assessment = (gaps: readonly KnowledgeGap[], primary?: string): KnowledgeGapAssessment => ({
  format: "duo.gap-assessment/1", status: "assessed", gaps, requiresHumanInput: primary !== undefined, ...(primary === undefined ? {} : { primary }), additional: [],
  technicalLimitations: [], metrics: { declaredConsidered: 0, runtime: gaps.length, direct: gaps.length, related: 0, none: 0, ask: primary === undefined ? 0 : 1, surface: 1, ignore: 0, llmCalls: 0 },
});

describe("missing-intent wording (C258)", () => {
  it("English and Korean name the assembled context, for both reasons", () => {
    for (const code of ["no-seed", "no-confirmed-intent"] as const) {
      expect(renderGapQuestion(missing(code))).toBe(EN);
      expect(renderGapQuestion(missing(code), { locale: "ko" })).toBe(KO);
    }
  });

  it("never says this task, never says no Decision exists", () => {
    for (const locale of ["en", "ko"] as const) {
      const text = renderGapQuestion(missing("no-confirmed-intent"), { locale });
      expect(text).not.toMatch(/this task|이 작업|linked to/u);
      expect(text).not.toMatch(/No confirmed (Requirement or )?Decision (exists|is)/u);
    }
  });

  it("is a surfaced note, not a question, and stays next to an ask question", () => {
    const ask: KnowledgeGap = { id: "rgap-ask", source: "runtime", kind: "unresolved-target", anchors: [], relevance: "direct", reasons: [{ code: "unresolved-id", ref: "REQ-999" }], action: "ask", target: "REQ-999" };
    const q = renderGapQuestions(assessment([ask, missing("no-confirmed-intent")], "rgap-ask"));
    expect(q.primaryQuestion).toBe("REQ-999 is not in the Project Truth. Which Requirement or Issue do you mean?");
    expect(q.notes).toEqual([{ id: "rgap-no-confirmed-intent", note: EN }]);
    expect(renderGapQuestions(assessment([missing("no-seed")])).notes).toEqual([{ id: "rgap-no-seed", note: EN }]);
  });
});
