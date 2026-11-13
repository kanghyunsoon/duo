import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, initialLanguage, LANGUAGE_STORAGE_KEY } from "./i18n.js";
import { en } from "./locales/en.js";
import { ko } from "./locales/ko.js";
import { Candidate } from "./pages/decisions.js";
import { CoverageTable } from "./pages/coverage.js";
import { ReviewView } from "./pages/review.js";
import type { ReviewResult } from "./types.js";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("UI localization", () => {
  it("preserves zero counts in translated sentences", async () => {
    await i18n.changeLanguage("ko");
    const html = renderToStaticMarkup(<CoverageTable analysis={{ analyzerRegistryDigest: "test", files: { total: 0, structural: 0, fileOnly: 0 }, languages: [], fileOnly: { level: "L0", files: 0, extensions: [] } }} />);
    expect(html).toContain("인덱싱된 파일 0개 · 구조 분석 0개 · 파일 단위 분석만 0개");
  });
  it("keeps both catalogs complete and preserves component/interpolation placeholders", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (value: string) => [...value.matchAll(/<\/?([a-z]\d+)\s*\/?\s*>|\{\{([^}]+)\}\}|(?<!\{)\{([^{}]+)\}(?!\})/gu)]
      .map((match) => match[1] ?? match[2] ?? match[3]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ko[key].trim(), key).not.toBe("");
      expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("defaults to English and handles unsupported or unavailable storage", () => {
    expect(initialLanguage()).toBe("en");
    expect(initialLanguage({ getItem: (key) => key === LANGUAGE_STORAGE_KEY ? "en" : null })).toBe("en");
    expect(initialLanguage({ getItem: (key) => key === LANGUAGE_STORAGE_KEY ? "ko" : null })).toBe("ko");
    expect(initialLanguage({ getItem: () => "fr" })).toBe("en");
    expect(initialLanguage({ getItem: () => { throw new Error("Storage disabled"); } })).toBe("en");
  });

  it("translates decision safeguards while preserving and escaping the exact candidate", async () => {
    await i18n.changeLanguage("ko");
    const html = renderToStaticMarkup(<Candidate preview={{ sourceKind: "proposal", expectedDecisionId: "D-001",
      candidate: { title: "<script>alert(1)</script>", question: "architecture", answer: "DbClient", governs: { paths: ["src/ui/**"] }, forbids: { imported_paths: ["src/db/legacy-db.ts"] } },
      stale: { truthChanged: true, changedRefs: ["REQ-001"] } }} />);
    expect(html).toContain("금지 범위");
    expect(html).toContain("저장소 전체 (governs는 금지 범위를 제한하지 않습니다)");
    expect(html).toContain("REQ-001");
    expect(html).toContain("D-001");
    expect(html).toContain("DbClient");
    expect(html).toContain("src/db/legacy-db.ts");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("localizes review semantics without translating verdicts or API diagnostics", async () => {
    await i18n.changeLanguage("ko");
    const r: ReviewResult = { status: "ready", verdict: "PASS", baseline: { status: "present" },
      claims: [], evidence: [], limitations: [], metrics: { llmCalls: 0 },
      semanticAssist: { status: "not-requested", calls: 0, cacheHits: 0, claims: [], skippedChecks: [] } };
    const html = renderToStaticMarkup(<ReviewView r={r} />);
    expect(html).toContain("규칙 기반 리뷰");
    expect(html).toContain(">PASS<");
    expect(html).toContain("테스트 통과나 버그가 없음을 보장하지 않습니다");
    expect(html).toContain("duoctl review --record");
    expect(renderToStaticMarkup(<ReviewView r={{ ...r, status: "failed", diagnostics: [{ code: "PROJECT_TRUTH_INVALID", message: "Original diagnostic" }] }} />))
      .toContain("Original diagnostic");
  });
});
