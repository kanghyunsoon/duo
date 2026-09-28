import fs from "node:fs";
import { createAnalyzerRegistry, type AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import { indexRepository } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { baseRegistry, cleanRebuild, countingRegistry, edge, makeRepo, memoryStore, nodeExists } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const FILES: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: poly\n",
  "package.json": JSON.stringify({ name: "poly", private: true, type: "module" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
  "web/main.ts": 'import { greet } from "./greet.js";\nexport function main(): string {\n  return greet();\n}\n',
  "web/greet.ts": 'export function greet(): string {\n  return "hi";\n}\n',
  "api/src/main/java/com/poly/UserService.java": "package com.poly;\nimport java.util.List;\npublic class UserService {\n  public List<String> names() { return List.of(helper()); }\n  private String helper() { return \"a\"; }\n}\n",
  "svc/app/__init__.py": "",
  "svc/app/users.py": "def normalize(name):\n    return name.strip()\n\ndef create(name):\n    return normalize(name)\n",
  "svc/app/main.py": "from .users import create\nimport app.users\nimport os\n\ndef run():\n    return create('a')\n",
  "engine/src/math.h": "#pragma once\nint clamp(int v);\n",
  "engine/src/math.cpp": '#include "math.h"\n#include <vector>\nstatic int twice(int v) { return v * 2; }\nint clamp(int v) { return twice(v); }\n',
  "tools/build.foo": "anything the analyzers do not know\n",
};

describe("polyglot repository (T18.0)", () => {
  it("indexes every language with its own analyzer and resolver, and keeps unknown files as L0", async () => {
    const repo = makeRepo(temps, FILES);
    const store = memoryStore();
    try {
      const r = await indexRepository(repo.root, { store, registry: base });
      expect(r.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
      // Files no analyzer claims are counted under "file-only".
      expect(Object.keys(r.value?.metrics.languages ?? {})).toEqual(["cpp", "file-only", "java", "python", "typescript"]);
      // TypeScript: module bindings as before.
      expect(edge(store, "file:web/main.ts", "IMPORTS", "file:web/greet.ts")).toBeDefined();
      expect(edge(store, "sym:web/main.ts#main", "CALLS", "sym:web/greet.ts#greet")).toBeDefined();
      // Python: relative import and a same-repository absolute import resolve; os is external; CALLS only within a module.
      expect(edge(store, "file:svc/app/main.py", "IMPORTS", "file:svc/app/users.py")).toBeDefined();
      expect(edge(store, "sym:svc/app/users.py#create", "CALLS", "sym:svc/app/users.py#normalize")).toBeDefined();
      expect(edge(store, "sym:svc/app/main.py#run", "CALLS", "sym:svc/app/users.py#create")).toBeUndefined();
      // C++: a quoted include next to the file resolves (the header is C++: C++ sources and no C sources).
      expect(edge(store, "file:engine/src/math.cpp", "IMPORTS", "file:engine/src/math.h")).toBeDefined();
      expect(edge(store, "sym:engine/src/math.cpp#clamp", "CALLS", "sym:engine/src/math.cpp#twice")).toBeDefined();
      expect(nodeExists(store, "sym:engine/src/math.h#clamp")).toBe(true);
      // Java: structure without CALLS edges (callResolution none).
      expect(nodeExists(store, "sym:api/src/main/java/com/poly/UserService.java#UserService.names")).toBe(true);
      expect(edge(store, "sym:api/src/main/java/com/poly/UserService.java#UserService.names", "CALLS", "sym:api/src/main/java/com/poly/UserService.java#UserService.helper")).toBeUndefined();
      // Unknown language: a file node (L0) and nothing else.
      expect(nodeExists(store, "file:tools/build.foo")).toBe(true);

      const inspection = await inspectIndex(repo.root, { graph: store, registry: base });
      const coverage = inspection.value?.coverage;
      expect(coverage?.analyzerRegistryDigest).toBe(base.digest());
      expect(coverage?.languages.map((l) => [l.language, l.files, l.capabilities.calls])).toEqual([
        ["cpp", 2, "partial"], ["java", 1, "syntactic"], ["python", 3, "partial"], ["typescript", 2, "partial"],
      ]);
      expect(coverage?.fileOnlyExtensions).toEqual(expect.arrayContaining([{ extension: "foo", files: 1 }, { extension: "json", files: 2 }]));

      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
    } finally {
      store.close();
    }
  });

  it("adding an analyzer re-parses only that language's files and reuses the rest (registry digest)", async () => {
    const repo = makeRepo(temps, FILES);
    const store = memoryStore();
    try {
      const withoutJava = countingRegistry(createAnalyzerRegistry(base.analyzers.filter((a) => a.id !== "java")));
      const first = await indexRepository(repo.root, { store, registry: withoutJava.registry });
      expect(first.value?.metrics.languages.java).toBeUndefined();
      expect(nodeExists(store, "file:api/src/main/java/com/poly/UserService.java")).toBe(true);

      const all = countingRegistry(base);
      const second = await indexRepository(repo.root, { store, registry: all.registry });
      expect(second.value?.mode).toBe("incremental");
      expect(all.parses).toBe(1);
      expect(second.value?.metrics.languages.java).toMatchObject({ files: 1, parsed: 1, reused: 0 });
      expect(second.value?.metrics.languages.typescript).toMatchObject({ files: 2, parsed: 0, reused: 2 });
      expect(nodeExists(store, "sym:api/src/main/java/com/poly/UserService.java#UserService")).toBe(true);
      expect(dumpGraph(store)).toEqual(await cleanRebuild(repo.root, base, 500));
    } finally {
      store.close();
    }
  });

  it("a C header stays a generic file in a C repository", async () => {
    const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: c\n", "src/lib.c": "#include \"lib.h\"\nint f(void) { return 1; }\n", "src/lib.h": "int f(void);\n" });
    const store = memoryStore();
    try {
      await indexRepository(repo.root, { store, registry: base });
      expect(nodeExists(store, "file:src/lib.h")).toBe(true);
      expect(nodeExists(store, "sym:src/lib.h#f")).toBe(false);
    } finally {
      store.close();
    }
  });
});

