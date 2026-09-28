import { canonicalSourceText, sliceSource, type RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyzerRegistry } from "../registry.js";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";

let registry: AnalyzerRegistry;
beforeAll(async () => {
  const created = await createDefaultAnalyzerRegistry();
  if (created.value === undefined) throw new Error(JSON.stringify(created.diagnostics));
  registry = created.value;
});
afterAll(() => registry?.dispose());

const VARIANTS = [false, true].flatMap((crlf) => [false, true].flatMap((bom) => [false, true].map((finalNewline) => ({ crlf, bom, finalNewline }))));
const SOURCE = [
  'import { it } from "vitest";',
  "// duo: AUTH-01 표시 😀",
  "export function 표시(): string {",
  '  return "😀" + helper();',
  "}",
  'function helper(): string { return "가"; }',
  'it("테스트 😀", () => { 표시(); });',
];

describe.each(VARIANTS.map((v) => [`${v.crlf ? "CRLF" : "LF"}${v.bom ? " +BOM" : ""}${v.finalNewline ? " +final newline" : " no final newline"}`, v] as const))(
  "exact slicing of AST facts (%s, T09.1)",
  (_n, v) => {
    it("symbols, call sites, tests and annotations slice the canonical text", () => {
      const eol = v.crlf ? "\r\n" : "\n";
      const raw = (v.bom ? "\uFEFF" : "") + SOURCE.join(eol) + (v.finalNewline ? eol : "");
      const r = registry.analyze({ path: "a.ts" as RepoPath, content: new TextEncoder().encode(raw) });
      const a = r.value;
      expect(a?.parseStatus).toBe("complete");
      const text = canonicalSourceText(raw);
      const at = (needle: string, end: string) => {
        const i = text.indexOf(needle);
        return text.slice(i, text.indexOf(end, i) + end.length);
      };
      const slice = (loc: { path: string } | undefined) => sliceSource(text, loc ?? { path: "" });
      expect(slice(a?.symbols.find((s) => s.name === "표시")?.location).value).toBe(at("function 표시", "\n}"));
      expect(slice(a?.symbols.find((s) => s.name === "helper")?.location).value).toBe(at("function helper", '"가"; }'));
      expect(slice(a?.callSites.find((c) => c.calleeText === "helper")?.location).value).toBe("helper()");
      expect(slice(a?.callSites.find((c) => c.calleeText === "표시")?.location).value).toBe("표시()");
      expect(slice(a?.tests[0]?.location).value).toBe(at('it("테스트', "})")); // the call expression, without the ";"
      expect(slice(a?.annotations[0]?.location).value).toBe("duo: AUTH-01 표시 😀");
      for (const loc of [...(a?.symbols ?? []).map((s) => s.location), ...(a?.callSites ?? []).map((c) => c.location), ...(a?.moduleReferences ?? []).map((m) => m.location)]) {
        expect(slice(loc).diagnostics).toEqual([]);
      }
    });
  },
);

