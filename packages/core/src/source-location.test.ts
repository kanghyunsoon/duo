import { describe, expect, it } from "vitest";
import { parseDefinitionMarkdown } from "./domain/definitions.js";
import { parseDecisionFile } from "./domain/files.js";
import { canonicalSourceText, sliceSource } from "./location.js";

/** Every combination of line endings, BOM and final newline (T09.1). */
const VARIANTS = [false, true].flatMap((crlf) => [false, true].flatMap((bom) => [false, true].map((finalNewline) => ({ crlf, bom, finalNewline }))));
const raw = (lines: readonly string[], v: (typeof VARIANTS)[number]) =>
  (v.bom ? "\uFEFF" : "") + lines.join(v.crlf ? "\r\n" : "\n") + (v.finalNewline ? (v.crlf ? "\r\n" : "\n") : "");
const name = (v: (typeof VARIANTS)[number]) => `${v.crlf ? "CRLF" : "LF"}${v.bom ? " +BOM" : ""}${v.finalNewline ? " +final newline" : " no final newline"}`;

const SPEC = [
  "# 인증 😀", "",
  "## AUTH-01 로그인 😀", "", "```duo", "status: planned", "```", "", "사용자가 로그인한다. emoji 😀 ascii.", "",
  "## AUTH-02 Logout", "", "```duo", "status: planned", "```", "", "Last section runs to EOF 😀",
];
const DECISION = ["id: D-001", "title: 비밀번호 로그인 😀", "state: confirmed", "question: login", "answer: password"];
const ADR = ["---", "id: ADR-001", "type: decision", "title: 언어 😀", "state: confirmed", "question: q", "answer: a", "---", "", "# ADR-001 😀", "", "본문."];

describe.each(VARIANTS.map((v) => [name(v), v] as const))("exact slicing of Truth definitions (%s)", (_n, v) => {
  it("Markdown sections, including the last one at EOF", () => {
    const text = canonicalSourceText(raw(SPEC, v));
    const defs = parseDefinitionMarkdown("s.md", text).value;
    const [first, last] = defs?.requirements ?? [];
    const second = text.indexOf("## AUTH-02");
    expect(sliceSource(text, first?.location ?? { path: "" })).toEqual({ value: text.slice(text.indexOf("## AUTH-01"), second), diagnostics: [] });
    expect(sliceSource(text, last?.location ?? { path: "" }).value).toBe(text.slice(second));
  });

  it("an ADR-style Markdown Decision is the whole file", () => {
    const text = canonicalSourceText(raw(ADR, v));
    const d = parseDefinitionMarkdown("adr.md", text).value?.decisions[0];
    expect(sliceSource(text, d?.location ?? { path: "" }).value).toBe(text);
  });

  it("a YAML Decision is its document content", () => {
    const text = canonicalSourceText(raw(DECISION, v));
    const d = parseDecisionFile("D-001.yaml", text).value;
    expect(sliceSource(text, d?.location ?? { path: "" }).value).toBe(text.replace(/\n$/u, ""));
  });
});

describe("invalid locations are refused, never clamped", () => {
  const text = "a😀\nb";
  it.each([
    ["past the last column", { path: "x", startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 }],
    ["past the last line", { path: "x", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 }],
    ["inside a surrogate pair is still a code-unit range, but past the line end is not", { path: "x", startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }],
    ["an incomplete range", { path: "x", startLine: 1, endLine: 2 }],
    ["end before start", { path: "x", startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 }],
  ])("%s", (_label, location) => {
    expect(sliceSource(text, location).diagnostics.map((d) => d.code)).toEqual(["SOURCE_LOCATION_INVALID"]);
  });
  it("accepts the end of the text and a path-only location", () => {
    expect(sliceSource(text, { path: "x", startLine: 1, startColumn: 1, endLine: 2, endColumn: 2 }).value).toBe(text);
    expect(sliceSource("a\n", { path: "x", startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }).value).toBe("a\n");
    expect(sliceSource(text, { path: "x" }).value).toBe(text);
  });
});

