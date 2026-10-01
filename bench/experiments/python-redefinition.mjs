// T24.2 Phase 0-A probe, extended in T24.4 (C226): Python same-name definitions. Per case: the Symbols the analyzer
// makes (primary and other locations), what the Context Packet shows, the Symbol's Evidence (pointer lines and the
// aggregate content hash), and the Review seeds of an edit to the first and to the last definition.
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

// edits: [label, from, to] applied one at a time to the committed file.
const CASES = {
  "A-redefinition": { task: "foo", symbol: "foo", text: ["def foo():", "    return 1", "", "", "def foo():", "    return 2", ""], edits: [["first", "    return 1", "    return 11"], ["last", "    return 2", "    return 3"]] },
  "B-typing-overload": { task: "foo", symbol: "foo", text: ["from typing import overload", "", "", "@overload", "def foo(x: int) -> int: ...", "", "", "@overload", "def foo(x: str) -> str: ...", "", "", "def foo(x):", "    return x", ""], edits: [["stub", "def foo(x: str) -> str: ...", "def foo(x: bytes) -> bytes: ..."], ["implementation", "    return x", "    return [x]"]] },
  "C-method-redefinition": { task: "A foo", symbol: "A.foo", text: ["class A:", "    def foo(self):", "        return 1", "", "    def foo(self, x):", "        return x", ""], edits: [["first", "        return 1", "        return 11"], ["last", "        return x", "        return x + 1"]] },
  "D-typing-dot-overload": { task: "foo", symbol: "foo", text: ["import typing", "", "", "@typing.overload", "def foo(x: int) -> int: ...", "", "", "def foo(x):", "    return x", ""], edits: [["stub", "def foo(x: int) -> int: ...", "def foo(x: float) -> float: ..."]] },
  "E-property-setter": { task: "A value", symbol: "A.value", text: ["class A:", "    @property", "    def value(self):", "        return self._v", "", "    @value.setter", "    def value(self, x):", "        self._v = x", ""], edits: [["setter", "        self._v = x", "        self._v = x + 1"]] },
  "F-conditional": { task: "foo", symbol: "foo", text: ["import sys", "", "if sys.platform == 'win32':", "    def foo():", "        return 1", "else:", "    def foo():", "        return 2", ""], edits: [["else", "        return 2", "        return 3"]] },
};
const FILE = "pkg/mod.py";
const out = {};
for (const [id, c] of Object.entries(CASES)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-pyredef-")));
  const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", ...a], { cwd: root, stdio: "pipe" });
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, FILE), c.text.join("\n"));
  git("-c", "init.defaultBranch=main", "init", "-q"); git("add", "-A"); git("commit", "-qm", "s");
  spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8" });
  git("add", "-A"); git("commit", "-qm", "init");
  const store = openProjectGraphStore(root).value;
  await indexRepository(root, { store, registry });
  const nodes = dumpGraph(store).nodes.map((n) => JSON.parse(n)).filter((n) => n.id === "sym:" + FILE + "#" + c.symbol);
  const ev = new EvidenceStore();
  const evidence = nodes.map((n) => {
    const eid = repositoryEvidence(ev, new SourceReader(root), store.getNode(symbolRef(FILE, c.symbol)), "WORKTREE");
    const e = ev.get(eid);
    return { id: n.id, evidenceId: eid, pointerLines: e?.pointer?.lines ?? null, contentHash: e?.contentHash ?? null };
  });
  store.close();
  const ctx = await projectContext(root, { task: c.task }, { registry });
  const items = (ctx.payload?.context?.packet?.code ?? []).filter((x) => x.id === "sym:" + FILE + "#" + c.symbol)
    .map((x) => ({ level: x.level, source: x.source?.startLine + "-" + x.source?.endLine, head: x.text.split("\n")[0], definitions: (x.text.match(/^\s*(async )?def /gmu) ?? []).length }));
  const seeds = {};
  const original = fs.readFileSync(path.join(root, FILE), "utf8");
  for (const [label, from, to] of c.edits) {
    fs.writeFileSync(path.join(root, FILE), original.replace(from, to));
    const st = openProjectGraphStore(root).value; await indexRepository(root, { store: st, registry }); st.close();
    const rv = await projectReview(root, { diff: { from: "HEAD", to: "WORKTREE" } }, { registry });
    seeds[label] = (rv.payload?.seeds ?? []).map((s) => s.ref + " " + s.reason);
    fs.writeFileSync(path.join(root, FILE), original);
  }
  out[id] = {
    symbols: nodes.map((n) => ({ id: n.id, kind: n.payload.kind, source: n.source.startLine + "-" + n.source.endLine, additional: (n.payload.additionalLocations ?? []).map((l) => l.startLine + "-" + l.endLine) })),
    context: items, evidence, reviewSeeds: seeds,
  };
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
console.log(JSON.stringify(out, null, 1));

