import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown.js";

const lines = [
  "---",
  "id: ADR-001",
  "type: decision",
  "---",
  "",
  "# Title",
  "",
  "## REQ-A-001 First",
  "",
  "```duo",
  "status: planned",
  "```",
  "",
  "Body with [link](other.md#part).",
  "",
  "- **AC-001-01** does x",
  "  - nested item",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
];

describe.each([["LF", "\n"], ["CRLF", "\r\n"]])("parseMarkdown (%s)", (_name, eol) => {
  const doc = parseMarkdown("docs/a.md", lines.join(eol)).value;

  it("extracts frontmatter and blocks with source positions", () => {
    expect(doc?.frontmatter?.value.replace(/\r/g, "")).toBe("id: ADR-001\ntype: decision");
    expect(doc?.frontmatter?.contentStartLine).toBe(2);
    expect(doc?.blocks.map((b) => b.kind)).toEqual(["heading", "heading", "code", "other", "other", "code"]);
    const heading = doc?.blocks[1];
    expect(heading).toMatchObject({ kind: "heading", depth: 2, text: "REQ-A-001 First", location: { path: "docs/a.md", startLine: 8 } });
    const block = doc?.blocks[2];
    expect(block).toMatchObject({ kind: "code", lang: "duo", contentStartLine: 11, location: { startLine: 10, endLine: 12 } });
    expect(block?.kind === "code" && block.value.replace(/\r/g, "")).toBe("status: planned");
  });

  it("extracts list items with a leading strong run", () => {
    expect(doc?.listItems.map((i) => [i.leadingStrong, i.text, i.location.startLine])).toEqual([
      ["AC-001-01", "does x", 16],
      [undefined, "nested item", 17],
    ]);
  });

  it("extracts links and text for evidence and mention scanning", () => {
    expect(doc?.links).toEqual([{ url: "other.md#part", location: expect.objectContaining({ startLine: 14 }) }]);
    expect(doc?.texts.map((t) => t.value)).toContain("const x = 1;");
  });
});
