/**
 * T24.3 (C218): linked C++ declarations and definitions in the Context Compiler and Review. A name whose
 * candidates are one linked group seeds the group and the Packet shows it once with every range; other
 * ambiguities stay; Review seeds and Evidence stay per persisted Symbol.
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { symbolRef, type RepoPath } from "@duo-director/core";
import { openProjectGraphStore, type GraphNode } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repositoryEvidence } from "../evidence/sources.js";
import { EvidenceStore } from "../evidence/store.js";
import { reviewChanges } from "../review/review.js";
import { SourceReader } from "./retrieve.js";
import { contextRegistry, HISTORY, makeContextRepo, REVIEW_FIXTURE, type ContextRepo } from "./testing.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const inc = (h: string) => `#include "${h}"\n`;
const CPP: Record<string, string> = {
  "native/Basic.h": "class Basic {\npublic:\n  void Foo(int value);\n};\n",
  "native/Basic.cpp": inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n",
  "native/Ns.h": "namespace one { void Run(int v); }\nnamespace two { void Run(int v); }\n",
  "native/Ns.cpp": inc("Ns.h") + "namespace one { void Run(int v) { (void)v; } }\nnamespace two { void Run(int v) { (void)v; } }\n",
  "native/Two.h": "class Alpha {\npublic:\n  void Go(int v);\n};\nclass Beta {\npublic:\n  void Go(int v);\n};\n",
  "native/Two.cpp": inc("Two.h") + "void Alpha::Go(int v) { (void)v; }\n",
  "native/Inner.h": "int Helper(int v);\n",
  "native/Inner.cpp": inc("Inner.h") + "static int Helper(int v) { return v; }\n",
};

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
  for (const [f, t] of Object.entries(CPP)) repo.write(f, t);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "native");
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const W = { from: "HEAD" as const, to: "WORKTREE" as const };
const H = "sym:native/Basic.h#Basic.Foo";
const C = "sym:native/Basic.cpp#Basic.Foo";

async function compile(task: string, explicit: readonly string[] = []) {
  const refs = explicit.map((id) => { const [p, s] = id.slice(4).split("#"); return symbolRef(p as RepoPath, s as string); });
  return repo.compile({ task, ...(refs.length === 0 ? {} : { explicitSeeds: refs }) });
}
const native = (r: Awaited<ReturnType<typeof compile>>) => (r.packet?.code ?? []).filter((c) => c.id.startsWith("sym:native/"));

async function seedsOf(): Promise<string[]> {
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(repo.root, { diff: W }, { graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result.seeds.map((s) => `${s.id} ${s.reason}`);
  } finally {
    opened.value.close();
  }
}

describe("linked C++ declarations and definitions (T24.3, C218)", () => {
  it("a qualified name whose candidates are one linked group is one target with both ranges", async () => {
    const r = await compile("Basic.Foo");
    expect(r.status).toBe("ready");
    // Both members match the qualified name. C251 (T50): the token resolved to one group, so its words are not BM25 input.
    expect(r.resolution?.seeds.filter((s) => s.match === "symbol").map((s) => s.id).sort()).toEqual([C, H]);
    expect(r.resolution?.seeds.filter((s) => s.match === "keyword")).toEqual([]);
    const items = native(r).filter((c) => c.id === H || c.id === C);
    expect(items).toHaveLength(1);
    const t = items[0]?.text ?? "";
    expect(t.split("\n")[0]).toBe("Basic.Foo (method) native/Basic.cpp:2-4 + native/Basic.h:3");
    expect(t).toContain("// native/Basic.cpp:2-4\nvoid Basic::Foo(int value) {");
    expect(t).toContain("// native/Basic.h:3\n  void Foo(int value);");
    // The class keeps its signature only: the declaration line is not shown twice.
    expect(native(r).find((c) => c.id === "sym:native/Basic.h#Basic")?.level).not.toBe("L3");
    expect(JSON.stringify((await compile("Basic.Foo")).packet)).toBe(JSON.stringify(r.packet));
  });

  it("namespaces keep separate groups; a name spanning two groups stays ambiguous", async () => {
    expect((await compile("one.Run")).status).toBe("ready");
    const one = native(await compile("one.Run"));
    expect(one.filter((c) => c.id.endsWith("#one.Run"))).toHaveLength(1);
    expect(one.find((c) => c.id.endsWith("#one.Run"))?.text.split("\n")[0]).toBe("one.Run (function) native/Ns.cpp:2 + native/Ns.h:1");
    expect((await compile("Run")).status).toBe("ambiguous");
  });

  it("an unlinked candidate keeps the ambiguity: internal linkage, another owner", async () => {
    expect((await compile("Helper")).status).toBe("ambiguous");
    const beta = await compile("Beta.Go");
    expect(beta.status).toBe("ready");
    expect(native(beta).find((c) => c.id === "sym:native/Two.h#Beta.Go")?.text.split("\n")[0]).toBe("Beta.Go (method) native/Two.h:7");
    expect((await compile("Alpha.Go")).status).toBe("ready");
  });

  it("Review: a hunk in the definition or the declaration seeds that Symbol; its Review context shows the group", async () => {
    repo.git("reset", "-q", "--hard");
    repo.edit("native/Basic.cpp", "(void)value;", "(void)(value + 1);");
    await repo.index();
    expect(await seedsOf()).toEqual([`${C} hunk-overlap`]);
    const fromDefinition = native(await compile("", [C])).filter((c) => c.id === H || c.id === C);
    expect(fromDefinition).toHaveLength(1);
    expect(fromDefinition[0]?.text).toContain("void Foo(int value);");
    repo.git("reset", "-q", "--hard");
    repo.edit("native/Basic.h", "void Foo(int value);", "void Foo(int value);  // entry point");
    await repo.index();
    expect(await seedsOf()).toEqual([`${H} hunk-overlap`]);
    const fromDeclaration = native(await compile("", [H])).filter((c) => c.id === H || c.id === C);
    expect(fromDeclaration).toHaveLength(1);
    expect(fromDeclaration[0]?.text).toContain("void Basic::Foo(int value) {");
    repo.git("reset", "-q", "--hard");
    await repo.index();
  });

  it("Evidence stays per persisted Symbol", async () => {
    const opened = openProjectGraphStore(repo.root);
    if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
    try {
      const store = new EvidenceStore();
      const reader = new SourceReader(repo.root);
      const ids = [H, C].map((id) => {
        const [p, s] = id.slice(4).split("#");
        return repositoryEvidence(store, reader, opened.value?.getNode(symbolRef(p as RepoPath, s as string)) as GraphNode, "WORKTREE") as string;
      });
      expect(new Set(ids).size).toBe(2);
      expect(ids.map((id) => store.get(id)?.pointer.path)).toEqual(["native/Basic.h", "native/Basic.cpp"]);
    } finally {
      opened.value.close();
    }
  });
});

