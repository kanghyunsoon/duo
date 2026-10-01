// T24.2 Phase 0-A probe: Python same-name definitions. Ordinary redefinition (the later def rebinds the name),
// typing.overload stubs + implementation, and a redefined method. Per case: the Symbols the analyzer makes, what the
// Context Packet shows, what the Symbol's Evidence text covers, and the Review seed of an edit to the last definition.
//   node bench/experiments/python-redefinition.mjs      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const { SourceReader } = await import(new URL("../../packages/director/dist/context/retrieve.js", import.meta.url).href);
const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { dumpGraph, indexRepository, openProjectGraphStore } = await import("@duo-director/graph");
const { EvidenceStore, repositoryEvidence } = await import("@duo-director/director");
const { symbolRef } = await import("@duo-director/core");
const { projectContext, projectReview } = await import("@duo-director/integration");
const registry = (await createDefaultAnalyzerRegistry()).value;

const CASES = {
  "A-redefinition": { task: "foo", file: "pkg/mod.py", text: ["def foo():", "    return 1", "", "", "def foo():", "    return 2", ""], edit: ["    return 2", "    return 3"] },
  "B-typing-overload": { task: "foo", file: "pkg/mod.py", text: ["from typing import overload", "", "", "@overload", "def foo(x: int) -> int: ...", "", "", "@overload", "def foo(x: str) -> str: ...", "", "", "def foo(x):", "    return x", ""], edit: ["    return x", "    return [x]"] },
  "C-method-redefinition": { task: "A foo", file: "pkg/mod.py", text: ["class A:", "    def foo(self):", "        return 1", "", "    def foo(self, x):", "        return x", ""], edit: ["        return x", "        return x + 1"] },
};
const out = {};
for (const [id, c] of Object.entries(CASES)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-pyredef-")));
  const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", ...a], { cwd: root, stdio: "pipe" });
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, c.file), c.text.join("\n"));
  git("-c", "init.defaultBranch=main", "init", "-q"); git("add", "-A"); git("commit", "-qm", "s");
  spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8" });
  git("add", "-A"); git("commit", "-qm", "init");
  const store = openProjectGraphStore(root).value;
  await indexRepository(root, { store, registry });
  const nodes = dumpGraph(store).nodes.map((n) => JSON.parse(n)).filter((n) => n.id.startsWith("sym:") && /foo$/u.test(n.id));
  const ev = new EvidenceStore();
  const evidence = nodes.map((n) => {
    const [p, s] = n.id.slice("sym:".length).split("#");
    const eid = repositoryEvidence(ev, new SourceReader(root), store.getNode(symbolRef(p, s)), "WORKTREE");
    const e = ev.get(eid);
    return { id: n.id, pointerLines: e?.pointer?.lines ?? null, excerpt: ev.excerpt(eid) };
  });
  store.close();
  const ctx = await projectContext(root, { task: c.task }, { registry });
  const items = (ctx.payload?.context?.packet?.code ?? []).filter((x) => /foo$/u.test(x.id)).map((x) => ({ id: x.id, level: x.level, source: x.source?.startLine + "-" + x.source?.endLine, text: x.text }));
  const text = fs.readFileSync(path.join(root, c.file), "utf8");
  fs.writeFileSync(path.join(root, c.file), text.replace(c.edit[0], c.edit[1]));
  const st2 = openProjectGraphStore(root).value; await indexRepository(root, { store: st2, registry }); st2.close();
  const rv = await projectReview(root, { diff: { from: "HEAD", to: "WORKTREE" } }, { registry });
  out[id] = {
    symbols: nodes.map((n) => ({ id: n.id, kind: n.payload.kind, source: n.source.startLine + "-" + n.source.endLine, additional: (n.payload.additionalLocations ?? []).map((l) => l.startLine + "-" + l.endLine) })),
    context: items, evidence, reviewSeedsAfterEditingLastDefinition: (rv.payload?.seeds ?? []).map((s) => s.ref + " " + s.reason),
  };
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
console.log(JSON.stringify(out, null, 1));
