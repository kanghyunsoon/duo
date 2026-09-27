import { describe, expect, it } from "vitest";
import { canonicalSourceText, sliceSource } from "../location.js";
import { parseMarkdown } from "../source/markdown.js";
import { parseDefinitionMarkdown } from "./definitions.js";
import { declaredGapId } from "./gaps.js";

const FENCE = "```";
const DOC = [
  "# Network",
  "",
  "UNKNOWN: project-level budget cap",
  "",
  "## NET-01 Session server",
  "",
  FENCE + "duo",
  "status: planned",
  FENCE,
  "",
  "Body text.",
  "",
  "UNKNOWN(max_users): 최대 동시 접속자 수 🎮",
  "",
  "- UNKNOWN: in a list item",
  "",
  "> UNKNOWN: in a quote",
  "",
  "**UNKNOWN:** strong marker",
  "",
  "Not a gap: `UNKNOWN: inside a sentence`",
  "`UNKNOWN: whole inline code line`",
  "",
  FENCE + "text",
  "UNKNOWN: fenced example",
  FENCE,
  "",
  "    UNKNOWN: indented code",
  "",
  "<!-- UNKNOWN: html comment -->",
  "",
  "### NET-02 Nested",
  "",
  FENCE + "duo",
  "status: planned",
  FENCE,
  "",
  "UNKNOWN: nested owner",
  "",
].join("\n");

const gapsOf = (text: string) => parseDefinitionMarkdown("specs/net.md", text).value?.gaps ?? [];

describe("UNKNOWN markers from the Markdown AST (TASK-011, C28)", () => {
  it("finds markers in prose only: paragraphs, list items, quotes, emphasis", () => {
    expect(gapsOf(DOC).map((g) => [g.owner.type === "project" ? "project" : g.owner.id, g.key ?? null, g.text])).toEqual([
      ["project", null, "project-level budget cap"],
      ["NET-01", "max_users", "최대 동시 접속자 수 🎮"],
      ["NET-01", null, "in a list item"],
      ["NET-01", null, "in a quote"],
      ["NET-01", null, "strong marker"],
      ["NET-02", null, "nested owner"],
    ]);
  });

  it("ignores code fences, indented code, inline code, HTML and YAML frontmatter", () => {
    const texts = gapsOf(DOC).map((g) => g.text).join("\n");
    for (const t of ["inside a sentence", "whole inline code line", "fenced example", "indented code", "html comment"]) expect(texts).not.toContain(t);
    const front = parseMarkdown("intent/vision.md", "---\nstatus: draft\nnote: \"UNKNOWN: in frontmatter\"\n---\n\n# Vision\n").value;
    expect(front?.unknownMarkers).toEqual([]);
  });

  it("an ADR-style Decision owns the gaps in its body", () => {
    const adr = [
      "---", "id: D-030", "type: decision", "title: Authoritative server", "state: confirmed", "question: authority", "answer: server",
      "governs:", "  requirements: [NET-01]", "supersedes: null", "---", "", "# D-030", "", "UNKNOWN: reconnect policy after a node failure", "",
    ].join("\n");
    expect(gapsOf(adr).map((g) => [g.owner, g.text])).toEqual([[{ type: "decision", id: "D-030" }, "reconnect policy after a node failure"]]);
  });

  it("locations slice exactly, in LF and CRLF checkouts", () => {
    for (const raw of [DOC, DOC.replace(/\n/g, "\r\n")]) {
      const text = canonicalSourceText(raw);
      const gap = parseDefinitionMarkdown("specs/net.md", text).value?.gaps.find((g) => g.key === "max_users");
      expect(gap === undefined ? undefined : sliceSource(text, gap.location).value).toBe("UNKNOWN(max_users): 최대 동시 접속자 수 🎮");
    }
  });

  it("IDs come from owner, key and normalized text, never the line", () => {
    const before = gapsOf(DOC);
    const after = gapsOf("Intro line.\n\n" + DOC);
    expect(after.map((g) => g.id)).toEqual(before.map((g) => g.id));
    expect(after[0]?.location.startLine).not.toBe(before[0]?.location.startLine);
    const reworded = gapsOf(DOC.replace("in a list item", "in  a LIST item"));
    expect(reworded.map((g) => g.id)).toEqual(before.map((g) => g.id));
    const changed = gapsOf(DOC.replace("in a list item", "in another list item"));
    expect(changed.filter((g) => !before.some((b) => b.id === g.id))).toHaveLength(1);
    expect(declaredGapId({ type: "requirement", id: "NET-01" }, "max_users", "최대 동시 접속자 수 🎮")).toBe(before[1]?.id);
    expect(before[1]?.id).toMatch(/^gap-[0-9a-f]{12}$/u);
  });
});

