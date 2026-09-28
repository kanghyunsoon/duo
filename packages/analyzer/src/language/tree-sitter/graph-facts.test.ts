import fs from "node:fs";
import type { RepoPath } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyzerRegistry } from "../registry.js";
import { createDefaultAnalyzerRegistry } from "../default-registry.js";

const FIXTURES = new URL("../../../../../fixtures/analyzer/", import.meta.url);
let registry: AnalyzerRegistry;
beforeAll(async () => {
  const r = await createDefaultAnalyzerRegistry();
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  registry = r.value;
});
afterAll(() => registry.dispose());
const analyze = (name: string) => {
  const r = registry.analyze({ path: name as RepoPath, content: fs.readFileSync(new URL(name, FIXTURES)) });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};

describe("facts for the Graph Builder (T07)", () => {
  it("lists local exports with exported and local names (same statement: exported-name order)", () => {
    expect(analyze("structure.ts").exports.map((e) => [e.exported, e.local ?? null, e.typeOnly])).toEqual([
      ["default", "Foo", false],
      ["outer", "outer", false],
      ["renamed", "a", false],
      ["fn", "fn", false],
      ["value", "value", false],
      ["T", "T", true],
      ["U", "U", true],
    ]);
  });

  it("gives calls a name path, local-root and this-binding facts", () => {
    const calls = analyze("structure.ts").callSites.map((c) => [
      c.calleePath?.join(".") ?? null, c.rootLocal ?? false, c.thisBinding ?? null, c.enclosingSymbol?.symbol ?? null, c.location.startLine,
    ]);
    expect(calls).toEqual([
      ["this.validate", false, "member", "Foo.save", 6],
      ["this.validate", false, "other", "Foo.save", 8],
      ["this.validate", false, "member", "Foo.save", 10],
      ["helper", false, null, "Foo.save", 11],
      ["helper", true, null, "a", 18],
      ["local", true, null, "outer", 23],
      ["Auth.login", false, null, "outer", 24],
      ["helper", false, null, "outer", 25],
    ]);
  });
});
