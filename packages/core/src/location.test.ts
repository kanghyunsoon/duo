import { describe, expect, it } from "vitest";
import { compareSourceLocations, sliceSourceLocation } from "./location.js";

describe("sliceSourceLocation", () => {
  const text = "const 한글 = \"😀\";\nfoo(한글);\n";
  it("uses UTF-16 columns and exclusive ends", () => {
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 1, startColumn: 7, endLine: 1, endColumn: 9 })).toBe("한글");
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 1, startColumn: 12, endLine: 1, endColumn: 16 })).toBe("\"😀\"");
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 1, startColumn: 1, endLine: 2, endColumn: 4 })).toBe("const 한글 = \"😀\";\nfoo");
  });

  it("finds the same slice in a CRLF checkout", () => {
    const crlf = text.replace(/\n/g, "\r\n");
    expect(sliceSourceLocation(crlf, { path: "a.ts", startLine: 2, startColumn: 1, endLine: 2, endColumn: 8 })).toBe("foo(한글)");
    expect(sliceSourceLocation(crlf, { path: "a.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 17 })).toBe("const 한글 = \"😀\";");
  });

  it("rejects locations outside the text", () => {
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 9, startColumn: 1, endLine: 9, endColumn: 2 })).toBeUndefined();
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 1, startColumn: 1, endLine: 1, endColumn: 99 })).toBeUndefined();
    expect(sliceSourceLocation(text, { path: "a.ts", startLine: 1 })).toBeUndefined();
  });
});

describe("compareSourceLocations", () => {
  it("orders by path, then start, then end", () => {
    const l = (path: string, startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn + 1) =>
      ({ path, startLine, startColumn, endLine, endColumn });
    const sorted = [l("b.ts", 1, 1), l("a.ts", 2, 1), l("a.ts", 1, 5), l("a.ts", 1, 1, 3, 1), l("a.ts", 1, 1)].sort(compareSourceLocations);
    expect(sorted).toEqual([l("a.ts", 1, 1), l("a.ts", 1, 1, 3, 1), l("a.ts", 1, 5), l("a.ts", 2, 1), l("b.ts", 1, 1)]);
  });
});
