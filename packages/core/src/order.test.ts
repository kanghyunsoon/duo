import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "./order.js";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/core/ordering.json", import.meta.url), "utf8")) as {
  readonly input: readonly string[];
  readonly expected: readonly string[];
};

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

describe("compareUtf8", () => {
  it("sorts the ordering fixture in UTF-8 byte order", () => {
    expect([...fixture.input].sort(compareUtf8)).toEqual(fixture.expected);
    expect([...fixture.input].sort(byBytes)).toEqual(fixture.expected);
  });

  it("differs from the default UTF-16 order for supplementary characters", () => {
    // U+1F600 (emoji) is F0 9F 98 80 in UTF-8, U+FF5E is EF BD 9E: the emoji sorts after.
    expect(["\u{1F600}", "\uFF5E"].sort()).toEqual(["\u{1F600}", "\uFF5E"]);
    expect(["\u{1F600}", "\uFF5E"].sort(compareUtf8)).toEqual(["\uFF5E", "\u{1F600}"]);
  });

  it("agrees with byte comparison on generated strings", () => {
    const alphabet = ["a", "B", "/", "-", ".", "\u00E9", "e\u0301", "\u00FF", "\uD7FF", "\uE000", "\uFFFD", "\u{10000}", "\u{1F600}", "\u{10FFFF}", "%"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const strings = Array.from({ length: 400 }, () =>
      Array.from({ length: 1 + (next() % 5) }, () => alphabet[next() % alphabet.length]).join(""));
    for (let i = 0; i + 1 < strings.length; i++) {
      const [a, b] = [strings[i] ?? "", strings[i + 1] ?? ""];
      expect(Math.sign(compareUtf8(a, b))).toBe(Math.sign(byBytes(a, b)));
    }
  });

  it("returns 0 only for equal strings and orders prefixes first", () => {
    expect(compareUtf8("src/a", "src/a")).toBe(0);
    expect(compareUtf8("src", "src/a")).toBe(-1);
    expect(compareUtf8("src/a", "src")).toBe(1);
  });
});
