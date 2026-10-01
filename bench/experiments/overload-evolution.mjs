// T24.1 Phase 1 probe: how the current Project Graph, Context and Review represent same-name overloads while a
// repository evolves (Java, C#, C++ in-class, C++ header declaration + source definitions). Per language one temporary
// Git repository; per case: commit the "before" text, index, write the "after" text, incremental index, capture the
// Symbols of the file, clean full rebuild, compare, then Context for an overload task and Review HEAD -> WORKTREE.
//   node bench/experiments/overload-evolution.mjs [--lang java,csharp,cpp,cpp-split]      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { dumpGraph, indexRepository, openProjectGraphStore } = await import("@duo-director/graph");
const { projectContext, projectReview } = await import("@duo-director/integration");
const registry = (await createDefaultAnalyzerRegistry()).value;

const J = (lines) => lines.join("\n") + "\n";
const java = {
  file: "src/main/java/app/Svc.java", task: "Svc foo count", marker: "count", first: "return 1",
  pre: ["package app;", "", "public class Svc {"], post: ["}"],
  foo: ["  public int foo() {", "    return 1;", "  }"],
  fooInt: ["  public int foo(int count) {", "    return count;", "  }"],
  fooIntBody: ["  public int foo(int count) {", "    return count + 1;", "  }"],
  fooStr: ["  public int foo(String count) {", "    return count.length();", "  }"],
};
const csharp = {
  file: "Game/Player.cs", task: "Player Move speed", marker: "speed", first: "return 1",
  pre: ["namespace Game", "{", "    public class Player", "    {"], post: ["    }", "}"],
  foo: ["        public int Move()", "        {", "            return 1;", "        }"],
  fooInt: ["        public int Move(int speed)", "        {", "            return speed;", "        }"],
  fooIntBody: ["        public int Move(int speed)", "        {", "            return speed + 1;", "        }"],
  fooStr: ["        public int Move(string speed)", "        {", "            return speed.Length;", "        }"],
};
const cpp = {
  file: "src/weapon.cpp", task: "AWeapon Fire count", marker: "count", first: "return 1",
  pre: ["class AWeapon {", "public:"], post: ["};"],
  foo: ["  int Fire() {", "    return 1;", "  }"],
  fooInt: ["  int Fire(int count) {", "    return count;", "  }"],
  fooIntBody: ["  int Fire(int count) {", "    return count + 1;", "  }"],
  fooStr: ["  int Fire(const char* count) {", "    return count[0];", "  }"],
};
// Out-of-class definitions in a .cpp next to the declarations in a .h (C218 stays separate: the two files are not linked).
const cppSplit = {
  file: "src/gun.cpp", header: "src/gun.h", task: "AGun Fire count", marker: "count", first: "return 1",
  pre: ["#include \"gun.h\"", ""], post: [],
  foo: ["int AGun::Fire() {", "  return 1;", "}"],
  fooInt: ["int AGun::Fire(int count) {", "  return count;", "}"],
  fooIntBody: ["int AGun::Fire(int count) {", "  return count + 1;", "}"],
  fooStr: ["int AGun::Fire(const char* count) {", "  return count[0];", "}"],
  headerOf: (decls) => J(["#pragma once", "class AGun {", "public:", ...decls, "};"]),
  decl: { foo: "  int Fire();", fooInt: "  int Fire(int count);", fooStr: "  int Fire(const char* count);" },
};
const LANGS = { java, csharp, cpp, "cpp-split": cppSplit };

const text = (L, parts) => J([...L.pre, ...parts.flatMap((p, i) => (i === 0 ? L[p] : ["", ...L[p]])), ...L.post]);
const header = (L, parts) => L.headerOf(parts.map((p) => L.decl[p === "fooIntBody" ? "fooInt" : p]));
const CASES = [
  { id: "1-add", before: ["foo"], after: ["foo", "fooInt"] },
  { id: "2-remove", before: ["foo", "fooInt"], after: ["foo"] },
  { id: "3-replace", before: ["foo", "fooInt"], after: ["foo", "fooStr"] },
  { id: "4-body", before: ["foo", "fooInt"], after: ["foo", "fooIntBody"] },
  { id: "5-reorder", before: ["foo", "fooInt"], after: ["fooInt", "foo"] },
];

const arg = process.argv.indexOf("--lang");
const only = arg < 0 ? Object.keys(LANGS) : process.argv[arg + 1].split(",");
const out = {};
for (const lang of only) {
  const L = LANGS[lang];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-overload-evo-")));
  const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", "-c", "core.autocrlf=false", ...a], { cwd: root, stdio: "pipe" });
  const write = (parts) => {
    const f = path.join(root, L.file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text(L, parts));
    if (L.header !== undefined) fs.writeFileSync(path.join(root, L.header), header(L, parts));
  };
  const clean = () => { for (const d of ["generated", "cache"]) fs.rmSync(path.join(root, ".duo-project", d), { recursive: true, force: true, maxRetries: 3 }); };
  const index = async () => {
    const store = openProjectGraphStore(root).value;
    try {
      const r = await indexRepository(root, { store, registry });
      const d = dumpGraph(store);
      return { mode: r.value?.mode ?? null, text: JSON.stringify(d), nodes: d.nodes.map((n) => JSON.parse(n)) };
    } finally { store.close(); }
  };
  const symbols = (g) => g.nodes.filter((n) => n.id.startsWith("sym:") && /(foo|Move|Fire)$/u.test(n.id)).map((n) => ({
    id: n.id, lines: n.source ? n.source.startLine + "-" + n.source.endLine : null,
    additional: (n.payload?.additionalLocations ?? []).map((l) => l.startLine + "-" + l.endLine),
  }));
  git("-c", "init.defaultBranch=main", "init", "-q");
  write(CASES[0].before);
  git("add", "-A"); git("commit", "-qm", "s0");
  spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8" });
  git("add", "-A"); git("commit", "-qm", "init");
  out[lang] = {};
  for (const c of CASES) {
    write(c.before); git("add", "-A"); git("commit", "-qm", c.id + " before", "--allow-empty");
    const before = await index();
    write(c.after);
    const inc = await index();
    clean();
    const full = await index();
    const ctx = await projectContext(root, { task: L.task }, { registry });
    const packet = ctx.kind === "ok" ? ctx.payload?.context?.packet : undefined;
    const rv = await projectReview(root, { diff: { from: "HEAD", to: "WORKTREE" } }, { registry });
    const review = rv.kind === "ok" ? rv.payload : undefined;
    out[lang][c.id] = {
      before: symbols(before), after: symbols(inc), incrementalMode: inc.mode, incrementalEqualsCleanFull: inc.text === full.text,
      context: (packet?.code ?? []).filter((x) => /(foo|Move|Fire)$/u.test(x.id)).map((x) => ({
        id: x.id, level: x.level, lines: x.source ? x.source.startLine + "-" + x.source.endLine : null, first: x.text.includes(L.first), second: x.text.includes(L.marker),
      })),
      reviewSeeds: (review?.seeds ?? []).map((s) => s.id + " (" + s.reason + ")"),
    };
    git("checkout", "--", "."); git("clean", "-fdq", "-e", ".duo-project");
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
console.log(JSON.stringify(out, null, 1));
