/**
 * C++ declaration links (T24.3, C218) through the real Indexer: exactly the proven pairs, and the links
 * recorded by an incremental index equal those of a clean full build while declarations, definitions,
 * files, names, signatures, overloads, qualifiers and namespaces change. The Graph itself equals a
 * clean rebuild at every step (links are metadata, not nodes or edges).
 */
import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyGraphPlan } from "../build/apply.js";
import { buildGraphPlan } from "../build/builder.js";
import { collectGraphFacts } from "../build/collect.js";
import { readDeclarationLinks, type DeclarationLink } from "../build/declaration-links.js";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, makeRepo, memoryStore, type TestRepo } from "./testing.js";

// 300 s like the other e2e files that index real repositories: the evolution test is the slowest file of the suite
// when every worker is busy (T28 timeout audit: about 45 s alone, over 240 s under full-suite load on Windows).
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let base: AnalyzerRegistry;
beforeAll(async () => { base = await baseRegistry(); });
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const inc = (h: string) => `#include "${h}"\n`;
const FORMS: Record<string, string> = {
  ".duo-project/project.yaml": "schema_version: 1\nname: cpp\n",
  "a/Basic.h": "class Basic {\npublic:\n  void Foo(int value);\n};\n", "a/Basic.cpp": inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n",
  "b/Over.h": "class Over {\npublic:\n  void Bar();\n  void Bar(int count);\n};\n", "b/Over.cpp": inc("Over.h") + "void Over::Bar() {}\nvoid Over::Bar(int count) {\n  (void)count;\n}\n",
  "c/Cq.h": "class Cq {\npublic:\n  int Get();\n  int Get() const;\n};\n", "c/Cq.cpp": inc("Cq.h") + "int Cq::Get() const { return 2; }\n",
  "d/Rq.h": "class Rq {\npublic:\n  void Take() &;\n  void Take() &&;\n};\n", "d/Rq.cpp": inc("Rq.h") + "void Rq::Take() && {}\n",
  "e/Ctor.h": "class Ctor {\npublic:\n  Ctor();\n  Ctor(int v);\n  ~Ctor();\n  bool operator==(const Ctor& o) const;\n};\n",
  "e/Ctor.cpp": inc("Ctor.h") + "Ctor::Ctor(int v) { (void)v; }\nCtor::~Ctor() {}\nbool Ctor::operator==(const Ctor& o) const { return this == &o; }\n",
  "h/Ns.h": "namespace one { void Run(int v); }\nnamespace two { void Run(int v); }\n", "h/Ns.cpp": inc("Ns.h") + "namespace one { void Run(int v) { (void)v; } }\nnamespace two { void Run(int v) { (void)v; } }\n",
  "i/Two.h": "class Alpha {\npublic:\n  void Go(int v);\n};\nclass Beta {\npublic:\n  void Go(int v);\n};\n", "i/Two.cpp": inc("Two.h") + "void Alpha::Go(int v) { (void)v; }\n",
  "j/Free.h": "int Twice(int v);\n", "j/Free.cpp": inc("Free.h") + "int Twice(int v) {\n  return v * 2;\n}\n",
  "k/Inner.h": "int Helper(int v);\nint Hidden(int v);\n", "k/Inner.cpp": inc("Inner.h") + "static int Helper(int v) { return v; }\nnamespace { int Hidden(int v) { return v; } }\n",
  "l/Tpl.h": "template <typename T> class Tpl {\npublic:\n  void Put(T v);\n};\n", "l/Tpl.cpp": inc("Tpl.h") + "template <typename T> void Tpl<T>::Put(T v) { (void)v; }\n",
  "m/Mac.h": "#define DECLARE_RUN(x) void x();\nclass Mac {\npublic:\n  DECLARE_RUN(Start)\n};\n", "m/Mac.cpp": inc("Mac.h") + "void Mac::Start() {}\n",
  "n/Def.h": "class Def {\npublic:\n  void Set(int value = 1, const char* name = \"x\");\n};\n", "n/Def.cpp": inc("Def.h") + "void Def::Set(int value, const char* name) { (void)value; (void)name; }\n",
  "o/Inl.h": "class Inl {\npublic:\n  void Now() {}\n};\n", "o/Inl.cpp": inc("Inl.h") + "void Inl::Now() {}\n",
  "p/NoInc.h": "class NoInc {\npublic:\n  void Do(int v);\n};\n", "p/NoInc.cpp": "void NoInc::Do(int v) { (void)v; }\n",
  "q/Diff.h": "class Diff {\npublic:\n  void Set(const int v);\n};\n", "q/Diff.cpp": inc("Diff.h") + "void Diff::Set(int const v) { (void)v; }\n",
  "r/St.h": "class St {\npublic:\n  static int Make(int v);\n};\n", "r/St.cpp": inc("St.h") + "int St::Make(int v) { return v; }\n",
  "s/Public/U.h": "class U {\npublic:\n  void Fire(int v);\n};\n", "s/Private/U.cpp": inc("U.h") + "void U::Fire(int v) { (void)v; }\n",
  "t/Dup.h": "class Dup {\npublic:\n  void Once(int v);\n};\n", "t/DupA.cpp": inc("Dup.h") + "void Dup::Once(int v) { (void)v; }\n", "t/DupB.cpp": inc("Dup.h") + "void Dup::Once(int v) { (void)v; }\n",
  // A written include path that ends two repository files is no evidence (same file name in two directories).
  "u/x/Same.h": "class Ux {\npublic:\n  void Do(int v);\n};\n", "u/y/Same.h": "int Unrelated(int v);\n", "u/impl/Ux.cpp": inc("Same.h") + "void Ux::Do(int v) { (void)v; }\n",
  // Unreal style: the include names the header by its module path, not next to the source.
  "v/Source/Game/Actions/ActionComp.h": "class UActionComp {\npublic:\n  bool StartByName(int Who, int Name);\n};\n",
  "v/Source/Game/Actions/ActionComp.cpp": inc("Actions/ActionComp.h") + "bool UActionComp::StartByName(int Who, int Name) {\n  return Who == Name;\n}\n",
};

const show = (links: readonly DeclarationLink[]) => links.map((l) => `${l.declaration.symbol.slice(4)}@${l.declaration.startLine} -> ${l.definition.symbol.slice(4)}@${l.definition.startLine}`);
/** The oracle: one clean full build (collect + build + apply into a fresh database), its links and its Graph rows. */
async function cleanBuild(root: string): Promise<{ links: string[]; graph: ReturnType<typeof dumpGraph> }> {
  const facts = await collectGraphFacts(root, { registry: base, maxCommits: 500 });
  if (facts.value === undefined) throw new Error(JSON.stringify(facts.diagnostics));
  const plan = buildGraphPlan(facts.value);
  const store = memoryStore();
  try {
    const applied = applyGraphPlan(store, plan);
    if (applied.value === undefined) throw new Error(JSON.stringify(applied.diagnostics));
    return { links: show(plan.declarationLinks), graph: dumpGraph(store) };
  } finally {
    store.close();
  }
}
async function index(repo: TestRepo, store: GraphStore) {
  const r = await indexRepository(repo.root, { store, registry: base });
  if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
}

describe("C++ declaration links (T24.3, C218)", () => {
  it("links exactly the proven declaration/definition pairs", async () => {
    const repo = makeRepo(temps, FORMS);
    const store = memoryStore();
    try {
      await index(repo, store);
      expect(show(readDeclarationLinks(store))).toEqual([
        "a/Basic.h#Basic.Foo@3 -> a/Basic.cpp#Basic.Foo@2",
        "b/Over.h#Over.Bar@3 -> b/Over.cpp#Over.Bar@2",
        "b/Over.h#Over.Bar@4 -> b/Over.cpp#Over.Bar@3",
        // Only the const overload is defined: the non-const declaration stays unlinked.
        "c/Cq.h#Cq.Get@4 -> c/Cq.cpp#Cq.Get@2",
        "d/Rq.h#Rq.Take@4 -> d/Rq.cpp#Rq.Take@2",
        "e/Ctor.h#Ctor.Ctor@4 -> e/Ctor.cpp#Ctor.Ctor@2",
        "e/Ctor.h#Ctor.operator==@6 -> e/Ctor.cpp#Ctor.operator==@4",
        "e/Ctor.h#Ctor.~Ctor@5 -> e/Ctor.cpp#Ctor.~Ctor@3",
        "h/Ns.h#one.Run@1 -> h/Ns.cpp#one.Run@2",
        "h/Ns.h#two.Run@2 -> h/Ns.cpp#two.Run@3",
        // Beta.Go has the same name and signature but another owner: never linked.
        "i/Two.h#Alpha.Go@3 -> i/Two.cpp#Alpha.Go@2",
        "j/Free.h#Twice@1 -> j/Free.cpp#Twice@2",
        "n/Def.h#Def.Set@3 -> n/Def.cpp#Def.Set@2",
        "r/St.h#St.static.Make@3 -> r/St.cpp#St.Make@2",
        // Public/Private: "U.h" ends exactly one repository file.
        "s/Public/U.h#U.Fire@3 -> s/Private/U.cpp#U.Fire@2",
        "v/Source/Game/Actions/ActionComp.h#UActionComp.StartByName@3 -> v/Source/Game/Actions/ActionComp.cpp#UActionComp.StartByName@2",
      ]);
      // Not linked: internal linkage (k), template (l), macro (m), header inline body (o), no include (p),
      // different spelling (q), two definitions of one declaration (t), an include path that ends two files (u).
      const clean = await cleanBuild(repo.root);
      expect(clean.links).toEqual(show(readDeclarationLinks(store)));
      expect(dumpGraph(store)).toEqual(clean.graph);
    } finally {
      store.close();
    }
  });

  it("incremental index records the same links as a clean full build while the C++ code evolves", async () => {
    const repo = makeRepo(temps, {
      ".duo-project/project.yaml": "schema_version: 1\nname: evo\n",
      "src/Basic.h": "class Basic {\npublic:\n  void Foo(int value);\n};\n",
      "src/Basic.cpp": inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n",
    });
    const store = memoryStore();
    const header = (body: string, ns?: string) => (ns === undefined ? body : `namespace ${ns} {\n${body}}\n`);
    try {
      await index(repo, store);
      const steps: [string, () => void, number][] = [
        ["declaration added", () => repo.edit("src/Basic.h", "  void Foo(int value);\n", "  void Foo(int value);\n  void Bar(int v);\n"), 1],
        ["definition added", () => fs.appendFileSync(`${repo.root}/src/Basic.cpp`, "void Basic::Bar(int v) { (void)v; }\n"), 2],
        ["definition deleted", () => repo.edit("src/Basic.cpp", "void Basic::Bar(int v) { (void)v; }\n", ""), 1],
        ["header renamed", () => { repo.rename("src/Basic.h", "src/BasicApi.h"); repo.edit("src/Basic.cpp", "Basic.h", "BasicApi.h"); }, 1],
        ["source renamed", () => repo.rename("src/Basic.cpp", "src/BasicImpl.cpp"), 1],
        ["method renamed in the header only", () => repo.edit("src/BasicApi.h", "void Foo(int value);", "void Fooz(int value);"), 0],
        ["method renamed in the source too", () => repo.edit("src/BasicImpl.cpp", "Basic::Foo(", "Basic::Fooz("), 1],
        ["parameter type changed in the header", () => repo.edit("src/BasicApi.h", "Fooz(int value)", "Fooz(long value)"), 0],
        ["parameter type changed in the source", () => repo.edit("src/BasicImpl.cpp", "Fooz(int value)", "Fooz(long value)"), 1],
        ["overload added", () => { repo.edit("src/BasicApi.h", "  void Bar(int v);\n", "  void Bar(int v);\n  void Fooz(double d);\n"); fs.appendFileSync(`${repo.root}/src/BasicImpl.cpp`, "void Basic::Fooz(double d) { (void)d; }\n"); }, 2],
        ["overload removed", () => { repo.edit("src/BasicApi.h", "  void Fooz(double d);\n", ""); repo.edit("src/BasicImpl.cpp", "void Basic::Fooz(double d) { (void)d; }\n", ""); }, 1],
        ["const added in the header", () => repo.edit("src/BasicApi.h", "Fooz(long value);", "Fooz(long value) const;"), 0],
        ["const added in the source", () => repo.edit("src/BasicImpl.cpp", "Fooz(long value) {", "Fooz(long value) const {"), 1],
        ["namespace in the header only", () => repo.write("src/BasicApi.h", header(repo.read("src/BasicApi.h"), "ns")), 0],
        ["namespace in the source too", () => repo.edit("src/BasicImpl.cpp", "void Basic::Fooz", "void ns::Basic::Fooz"), 1],
        ["class renamed", () => { repo.write("src/BasicApi.h", repo.read("src/BasicApi.h").replace("class Basic", "class Basik")); repo.edit("src/BasicImpl.cpp", "ns::Basic::Fooz", "ns::Basik::Fooz"); }, 1],
      ];
      for (const [label, change, count] of steps) {
        change();
        const r = await index(repo, store);
        expect(r.mode, label).toBe("incremental");
        const links = show(readDeclarationLinks(store));
        expect(links, label).toHaveLength(count);
        const clean = await cleanBuild(repo.root);
        expect(links, label).toEqual(clean.links);
        expect(dumpGraph(store), label).toEqual(clean.graph);
      }
      expect(show(readDeclarationLinks(store))).toEqual(["src/BasicApi.h#ns.Basik.Fooz@4 -> src/BasicImpl.cpp#ns.Basik.Fooz@2"]);
    } finally {
      store.close();
    }
  });
});

