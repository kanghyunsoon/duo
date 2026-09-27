import { describe, expect, it } from "vitest";
import { attachAnnotation } from "./annotations.js";

const loc = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ path: "a.ts", startLine, startColumn, endLine, endColumn });

describe("attachAnnotation", () => {
  const text = [
    "// duo: A-1",                  // 1
    "export function a() {",        // 2
    "  // duo: A-2",                // 3
    "  inner();",                   // 4
    "}",                            // 5
    "// duo: A-3",                  // 6
    "",                             // 7
    "/** docs */",                  // 8
    "export const b = () => {};",   // 9
    "// duo: A-4",                  // 10
    "",                             // 11
    "",                             // 12
    "function c() {}",              // 13
    "// duo: A-5",                  // 14
    "call();",                      // 15
    "function d() {}",              // 16
  ].join("\n");
  const candidates = [
    { value: "a", location: loc(2, 8, 5, 2) },
    { value: "b", location: loc(9, 14, 9, 26) },
    { value: "c", location: loc(13, 1, 13, 16) },
    { value: "d", location: loc(16, 1, 16, 16) },
  ];
  it.each([
    ["directly before (export keyword allowed)", loc(1, 4, 1, 12), { kind: "next", value: "a" }],
    ["inside a body with code after", loc(3, 6, 3, 14), { kind: "enclosing", value: "a" }],
    ["one blank line and a doc comment between", loc(6, 4, 6, 12), { kind: "next", value: "b" }],
    ["two blank lines: not attached to the next symbol", loc(10, 4, 10, 12), { kind: "file" }],
    ["code between: file level", loc(14, 4, 14, 12), { kind: "file" }],
  ])("%s", (_name, annotation, expected) => {
    expect(attachAnnotation(annotation, candidates, text)).toEqual(expected);
  });

  it("reads CRLF text the same way and falls back to the file without text", () => {
    expect(attachAnnotation(loc(1, 4, 1, 12), candidates, text.replace(/\n/g, "\r\n"))).toEqual({ kind: "next", value: "a" });
    expect(attachAnnotation(loc(1, 4, 1, 12), candidates, undefined)).toEqual({ kind: "file" });
  });

  it("handles an annotation inside a block comment that closes later", () => {
    const block = "/*\n * duo: A-9\n */\nfunction e() {}";
    expect(attachAnnotation(loc(2, 4, 2, 13), [{ value: "e", location: loc(4, 1, 4, 16) }], block)).toEqual({ kind: "next", value: "e" });
  });
});
