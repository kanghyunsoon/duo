import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { approximateTokens, countTokens, measureText, TOKEN_ESTIMATOR, truncateToTokens } from "./index.js";

describe("o200k_base token estimator (ADR-005, TASK-010)", () => {
  it("names the exact library version that is installed", () => {
    const pkg = createRequire(import.meta.url)("gpt-tokenizer/package.json") as { version: string };
    expect(TOKEN_ESTIMATOR).toEqual({ name: "o200k_base", library: "gpt-tokenizer", version: pkg.version });
  });

  it("counts o200k_base tokens deterministically", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
    const text = "Refresh token 만료 처리 🎉\nconst x = 1;";
    expect(countTokens(text)).toBe(countTokens(text));
  });

  it("measures special-token text as ordinary text instead of failing", () => {
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
  });

  it("reports bytes and code points with every token value (AC-010-06)", () => {
    expect(measureText("한글🎉")).toEqual({ tokens: countTokens("한글🎉"), estimator: "o200k_base", bytes: 10, chars: 3 });
  });

  it("truncates by tokens to a prefix", () => {
    const text = "one two three four five six seven eight nine ten";
    const cut = truncateToTokens(text, 3);
    expect(cut.truncated).toBe(true);
    expect(text.startsWith(cut.text)).toBe(true);
    expect(countTokens(cut.text)).toBeLessThanOrEqual(3);
    expect(truncateToTokens("short", 10)).toEqual({ text: "short", truncated: false });
  });

  it("keeps chars/4 separate and labelled as an approximation", () => {
    expect(approximateTokens("abcdefgh")).toEqual({ tokens: 2, estimator: "approx (chars/4)" });
  });
});
