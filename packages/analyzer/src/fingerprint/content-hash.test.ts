import { describe, expect, it } from "vitest";
import { canonicalContent, computeContentHash } from "./content-hash.js";

const bytes = (s: string) => Buffer.from(s, "utf8");
const text = (s: string) => computeContentHash(bytes(s), "normalized-text");

describe("computeContentHash", () => {
  it("is sha256 of the content with a prefix", () => {
    expect(text("hello\n")).toEqual({ contentHash: "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03", size: 6 });
  });

  it("gives CRLF and LF checkouts of the same text the same hash", () => {
    expect(text("a\r\nb\r\n")).toEqual(text("a\nb\n"));
    expect(text("a\r\nb\n")).toEqual(text("a\nb\n"));
  });

  it.each([
    ["lone CR", "a\rb\n", "a\nb\n"],
    ["CR CR LF keeps one CR", "a\r\r\nb", "a\r\nb"],
    ["BOM", "\uFEFFa\n", "a\n"],
    ["NFC vs NFD", "caf\u00E9\n", "cafe\u0301\n"],
    ["trailing space", "a \n", "a\n"],
    ["letter case", "A\n", "a\n"],
    ["tabs vs spaces", "\ta\n", "  a\n"],
    ["missing final newline", "a", "a\n"],
  ])("keeps a real difference: %s", (_name, a, b) => {
    expect(text(a).contentHash).not.toBe(text(b).contentHash);
  });

  it("CR CR LF becomes CR LF, not LF", () => {
    expect([...canonicalContent(bytes("a\r\r\nb"), "normalized-text")]).toEqual([...bytes("a\r\nb")]);
  });

  it("hashes binary files as raw bytes, CRLF included", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const lf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x1a, 0x0a]);
    expect(computeContentHash(png, "raw").size).toBe(8);
    expect(computeContentHash(png, "raw").contentHash).not.toBe(computeContentHash(lf, "raw").contentHash);
    expect(canonicalContent(png, "raw")).toBe(png);
  });

  it("size is the canonical byte length", () => {
    expect(text("\u00E9\r\n").size).toBe(3);
    expect(computeContentHash(new Uint8Array(), "normalized-text")).toEqual({
      contentHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0,
    });
  });
});
