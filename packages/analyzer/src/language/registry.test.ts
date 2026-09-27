import type { RepoPath } from "@duo-director/core";
import { success } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { createAnalyzerRegistry } from "./registry.js";
import { createTypeScriptAnalyzer } from "./tree-sitter/ts-js-analyzer.js";
import type { LanguageAnalyzer } from "./types.js";

const disposed: string[] = [];
const dummy: LanguageAnalyzer = {
  id: "dummy",
  version: "1",
  supports: (path) => path.endsWith(".dummy"),
  analyze: (input) => success({
    path: input.path, language: "dummy-lang", contentHash: "sha256:" + "0".repeat(64), parseStatus: "complete",
    symbols: [], moduleReferences: [], exports: [], callSites: [], annotations: [], tests: [],
  }),
  dispose: () => { disposed.push("dummy"); },
};

describe("analyzer registry (AC-005-04)", () => {
  const cleanup: (() => void)[] = [];
  afterAll(() => cleanup.forEach((f) => f()));

  it("adds a language without changing anything else", async () => {
    const ts = (await createTypeScriptAnalyzer()).value;
    if (ts === undefined) throw new Error("no analyzer");
    const registry = createAnalyzerRegistry([ts, dummy]);
    cleanup.push(() => registry.dispose());
    expect(registry.analyzerFor("x.dummy" as RepoPath)?.id).toBe("dummy");
    expect(registry.analyzerFor("x.ts" as RepoPath)?.id).toBe("typescript");
    expect(registry.analyze({ path: "x.dummy" as RepoPath, content: new Uint8Array() }).value?.language).toBe("dummy-lang");
    expect(registry.analyze({ path: "x.py" as RepoPath, content: new Uint8Array() }).diagnostics.map((d) => d.code)).toEqual(["LANGUAGE_UNSUPPORTED"]);
  });

  it("rejects duplicate analyzer IDs and disposes every analyzer", () => {
    expect(() => createAnalyzerRegistry([dummy, dummy])).toThrow(/Duplicate/);
    createAnalyzerRegistry([dummy]).dispose();
    expect(disposed).toContain("dummy");
  });
});
