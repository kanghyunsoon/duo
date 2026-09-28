import type { RepoPath } from "@duo-director/core";
import { success } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { createAnalyzerRegistry } from "./registry.js";
import { createDefaultAnalyzerRegistry } from "./default-registry.js";
import { createTypeScriptAnalyzer } from "./tree-sitter/ts-js-analyzer.js";
import { FILE_ONLY_CAPABILITIES, type LanguageAnalyzer } from "./types.js";

const disposed: string[] = [];
const dummy: LanguageAnalyzer = {
  id: "dummy",
  version: "1",
  languages: ["dummy-lang"],
  extensions: ["dummy"],
  capabilities: FILE_ONLY_CAPABILITIES,
  callResolution: "none",
  identity: "sha256:dummy",
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

  it("decides a .h header from the repository (T18.0 header rule)", async () => {
    const registry = (await createDefaultAnalyzerRegistry()).value;
    if (registry === undefined) throw new Error("no registry");
    cleanup.push(() => registry.dispose());
    const h = "src/a.h" as RepoPath;
    const lang = (paths: string[]) => registry.scope(paths as RepoPath[]).languageFor(h);
    expect(lang(["src/a.h", "src/b.cpp"])).toBe("cpp"); // C++ sources, no C sources
    expect(lang(["src/a.h", "src/b.c"])).toBeUndefined(); // a C repository: generic file
    expect(lang(["src/a.h", "src/a.cpp", "src/b.c"])).toBe("cpp"); // same-stem C++ source
    expect(lang(["src/a.h", "src/b.cpp", "src/b.c"])).toBeUndefined(); // mixed, no evidence for this header
    expect(lang(["src/a.h", "src/b.c", "Game.uproject"])).toBe("cpp"); // Unreal project
    expect(lang(["src/a.h"])).toBeUndefined();
    expect(registry.scope([h]).capabilitiesFor(h).symbols).toBe("none");
    // The digest covers every analyzer: removing one changes it.
    expect(createAnalyzerRegistry(registry.analyzers.filter((a) => a.id !== "java")).digest()).not.toBe(registry.digest());
  });
});
