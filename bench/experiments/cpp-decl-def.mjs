// T24.3 probe (C218): C++ header declarations and source definitions. One temporary repository with one directory per
// form; per form: the Symbols, the Context status and code items for a task naming the callable, and the declaration
// links the Indexer recorded (Graph meta "declaration_links", absent before T24.3).
//   node bench/experiments/cpp-decl-def.mjs      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { dumpGraph, indexRepository, openProjectGraphStore } = await import("@duo-director/graph");
const { projectContext } = await import("@duo-director/integration");
const registry = (await createDefaultAnalyzerRegistry()).value;

const inc = (h) => "#include \"" + h + "\"\n";
const FORMS = {
  "A-member": { files: { "a/Basic.h": "class Basic {\npublic:\n  void Foo(int value);\n};\n", "a/Basic.cpp": inc("Basic.h") + "void Basic::Foo(int value) {\n  (void)value;\n}\n" }, task: "Basic.Foo" },
  "B-overload": { files: { "b/Over.h": "class Over {\npublic:\n  void Bar();\n  void Bar(int count);\n};\n", "b/Over.cpp": inc("Over.h") + "void Over::Bar() {}\nvoid Over::Bar(int count) {\n  (void)count;\n}\n" }, task: "Over.Bar" },
  "C-const": { files: { "c/Cq.h": "class Cq {\npublic:\n  int Get();\n  int Get() const;\n};\n", "c/Cq.cpp": inc("Cq.h") + "int Cq::Get() { return 1; }\nint Cq::Get() const { return 2; }\n" }, task: "Cq.Get" },
  "D-ref": { files: { "d/Rq.h": "class Rq {\npublic:\n  void Take() &;\n  void Take() &&;\n};\n", "d/Rq.cpp": inc("Rq.h") + "void Rq::Take() & {}\nvoid Rq::Take() && {}\n" }, task: "Rq.Take" },
  "E-constructor": { files: { "e/Ctor.h": "class Ctor {\npublic:\n  Ctor();\n  Ctor(int v);\n};\n", "e/Ctor.cpp": inc("Ctor.h") + "Ctor::Ctor() {}\nCtor::Ctor(int v) {\n  (void)v;\n}\n" }, task: "Ctor.Ctor" },
  "F-destructor": { files: { "f/Dtor.h": "class Dtor {\npublic:\n  ~Dtor();\n};\n", "f/Dtor.cpp": inc("Dtor.h") + "Dtor::~Dtor() {}\n" }, task: "Dtor" },
  "G-operator": { files: { "g/Op.h": "class Op {\npublic:\n  bool operator==(const Op& other) const;\n};\n", "g/Op.cpp": inc("Op.h") + "bool Op::operator==(const Op& other) const {\n  return this == &other;\n}\n" }, task: "Op" },
  "H-namespace": { files: { "h/Ns.h": "namespace one { void Run(int v); }\nnamespace two { void Run(int v); }\n", "h/Ns.cpp": inc("Ns.h") + "namespace one { void Run(int v) { (void)v; } }\nnamespace two { void Run(int v) { (void)v; } }\n" }, task: "one.Run" },
  "I-same-name": { files: { "i/Two.h": "class Alpha {\npublic:\n  void Go(int v);\n};\nclass Beta {\npublic:\n  void Go(int v);\n};\n", "i/Two.cpp": inc("Two.h") + "void Alpha::Go(int v) { (void)v; }\n" }, task: "Alpha.Go" },
  "J-free": { files: { "j/Free.h": "int Twice(int v);\n", "j/Free.cpp": inc("Free.h") + "int Twice(int v) {\n  return v * 2;\n}\n" }, task: "Twice" },
  "K-internal": { files: { "k/Inner.h": "int Helper(int v);\n", "k/Inner.cpp": inc("Inner.h") + "static int Helper(int v) {\n  return v;\n}\nnamespace {\nint Hidden(int v) { return v; }\n}\n", "k/Hidden.h": "int Hidden(int v);\n" }, task: "Helper" },
  "L-template": { files: { "l/Tpl.h": "template <typename T> class Tpl {\npublic:\n  void Put(T v);\n};\n", "l/Tpl.cpp": inc("Tpl.h") + "template <typename T> void Tpl<T>::Put(T v) {\n  (void)v;\n}\n" }, task: "Tpl.Put" },
  "M-macro": { files: { "m/Mac.h": "#define DECLARE_RUN(x) void x();\nclass Mac {\npublic:\n  DECLARE_RUN(Start)\n};\n", "m/Mac.cpp": inc("Mac.h") + "void Mac::Start() {}\n" }, task: "Mac.Start" },
  "N-default-arg": { files: { "n/Def.h": "class Def {\npublic:\n  void Set(int value = 1, const char* name = \"x\");\n};\n", "n/Def.cpp": inc("Def.h") + "void Def::Set(int value, const char* name) {\n  (void)value; (void)name;\n}\n" }, task: "Def.Set" },
  "O-inline-header": { files: { "o/Inl.h": "class Inl {\npublic:\n  void Now() {}\n};\n", "o/Inl.cpp": inc("Inl.h") + "void Inl::Now() {}\n" }, task: "Inl.Now" },
  "P-no-include": { files: { "p/NoInc.h": "class NoInc {\npublic:\n  void Do(int v);\n};\n", "p/NoInc.cpp": "void NoInc::Do(int v) {\n  (void)v;\n}\n" }, task: "NoInc.Do" },
  "Q-spelling": { files: { "q/Diff.h": "class Diff {\npublic:\n  void Set(const int v);\n};\n", "q/Diff.cpp": inc("Diff.h") + "void Diff::Set(int const v) {\n  (void)v;\n}\n" }, task: "Diff.Set" },
  "R-static-member": { files: { "r/St.h": "class St {\npublic:\n  static int Make(int v);\n};\n", "r/St.cpp": inc("St.h") + "int St::Make(int v) {\n  return v;\n}\n" }, task: "St.Make" },
  "S-public-private": { files: { "s/Public/U.h": "class U {\npublic:\n  void Fire(int v);\n};\n", "s/Private/U.cpp": inc("U.h") + "void U::Fire(int v) {\n  (void)v;\n}\n" }, task: "U.Fire" },
};
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-cppdd-")));
for (const f of Object.values(FORMS)) for (const [p, t] of Object.entries(f.files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); }
const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", ...a], { cwd: root, stdio: "pipe" });
git("-c", "init.defaultBranch=main", "init", "-q"); git("add", "-A"); git("commit", "-qm", "s");
spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8" });
const store = openProjectGraphStore(root).value;
let nodes, links;
try {
  await indexRepository(root, { store, registry });
  nodes = dumpGraph(store).nodes.map((n) => JSON.parse(n)).filter((n) => n.id.startsWith("sym:"));
  const raw = store.readMeta("declaration_links");
  links = raw === undefined ? null : JSON.parse(raw).pairs ?? [];
} finally { store.close(); }
const out = {};
for (const [id, f] of Object.entries(FORMS)) {
  const dir = Object.keys(f.files)[0].split("/")[0] + "/";
  const syms = nodes.filter((n) => n.id.startsWith("sym:" + dir) && !["class", "struct", "namespace"].includes(n.payload.kind))
    .map((n) => n.id.slice(4) + " " + n.payload.kind + " @" + n.source.startLine + ((n.payload.additionalLocations ?? []).length ? "+" + n.payload.additionalLocations.map((l) => l.startLine).join(",") : ""));
  const op = await projectContext(root, { task: f.task }, { registry });
  const p = op.payload?.context?.packet;
  out[id] = {
    symbols: syms,
    links: links === null ? "absent" : links.filter((l) => l.declaration.symbol.startsWith("sym:" + dir)).map((l) => l.declaration.symbol.slice(4) + "@" + l.declaration.startLine + " -> " + l.definition.symbol.slice(4) + "@" + l.definition.startLine),
    context: { task: f.task, status: op.payload?.status ?? op.kind, ambiguities: (op.payload?.context?.ambiguities ?? op.payload?.ambiguities ?? []).map((a) => a.term + ":" + a.options.length),
      code: (p?.code ?? []).filter((c) => c.id.startsWith("sym:" + dir)).map((c) => c.id.slice(4) + " " + c.level + " " + c.text.split("\n")[0].split(" ").slice(-1)[0]) },
    ...(process.argv.includes("--text") ? { texts: (p?.code ?? []).filter((c) => c.id.startsWith("sym:" + dir) && c.text.includes(" + ")).map((c) => c.text) } : {}),
  };
}
fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
console.log(JSON.stringify(out, null, 1));
