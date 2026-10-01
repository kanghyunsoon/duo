// T24.5 (C231) probe on the T23-pinned ActionRoguelike clone: a Decision governs the real header / cpp pair
// URogueActionComponent.StartActionByName. Adopted and indexed with an older DUO (--old <DUO checkout>, built), then
// opened with this checkout: status, context, one index, Review of a header edit, a cpp edit and both.
//   node bench/experiments/cpp-truth-groups.mjs --old <older DUO checkout> [--repo <ActionRoguelike clone>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { old: { type: "string" }, repo: { type: "string" } } });
if (values.old === undefined) throw new Error("--old <older DUO checkout> is required");
const NEW = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const OLD = path.join(path.resolve(values.old), "apps/cli/dist/main.js");
const SRC = values.repo ?? path.join(os.tmpdir(), "duo-bench-repos", "ActionRoguelike");
const { dumpGraph, openProjectGraphStore, readIndexState } = await import("@duo-director/graph");

const H = "Source/ActionRoguelike/ActionSystem/RogueActionComponent.h";
const C = "Source/ActionRoguelike/ActionSystem/RogueActionComponent.cpp";
const DECL = "bool StartActionByName(AActor* Instigator, FGameplayTag ActionName);";
const BODY = "TRACE_CPUPROFILER_EVENT_SCOPE(StartActionByName);";
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-c231-")));
const git = (...a) => execFileSync("git", ["-c", "user.name=D", "-c", "user.email=d@x.invalid", ...a], { cwd: root, stdio: "pipe", encoding: "utf8" });
const duo = (cli, args, input) => {
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd: root, input: input ?? "", encoding: "utf8", maxBuffer: 1 << 28 });
  try { return JSON.parse(r.stdout); } catch { return { exitCode: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }; }
};
const graph = () => {
  const store = openProjectGraphStore(root).value;
  try {
    const dump = dumpGraph(store);
    const edges = dump.edges.map((e) => JSON.parse(e));
    rows.set(rows.size, new Set([...dump.nodes, ...dump.edges]));
    return { governs: edges.filter((e) => e.from === "dec:D-900" && e.type === "GOVERNS").map((e) => e.to).sort(), nodes: dump.nodes.length, edges: edges.length };
  } finally { store.close(); }
};
const rows = new Map();
/** Canonical Graph rows only in one of two dumps (node and edge rows). */
const diff = (a, b) => ({ added: [...b].filter((x) => !a.has(x)).map((x) => JSON.parse(x)).map((x) => x.type === undefined ? x.id : `${x.from} ${x.type} ${x.to}`), removed: [...a].filter((x) => !b.has(x)).length });
const unresolved = () => (readIndexState(root).state?.diagnostics ?? []).filter((d) => d.code === "DECLARED_SYMBOL_UNRESOLVED" && d.message.startsWith("dec:D-900")).map((d) => d.message);
const claims = (out) => (out?.result?.claims ?? []).filter((c) => c.rule === "decision-governance" || c.rule === "declared-reference")
  .map((c) => `${c.rule} ${c.subject.id} ${c.alignment}${c.provenance === undefined ? "" : ` ${c.provenance}`}: ${c.observed}`);
const edit = (file, from, to) => { const p = path.join(root, file); const t = fs.readFileSync(p, "utf8"); if (!t.includes(from)) throw new Error(file + " lacks " + from); fs.writeFileSync(p, t.replace(from, to)); };
const reset = () => git("checkout", "-q", "--", H, C);

git("clone", "-q", "--no-hardlinks", SRC, ".");
fs.mkdirSync(path.join(root, ".duo-project/decisions"), { recursive: true });
fs.writeFileSync(path.join(root, ".duo-project/decisions/D-900.yaml"), [
  "id: D-900", "title: Actions start through the action component", "kind: decision", "state: confirmed", "question: start", "answer: component", "owner: human",
  "governs:", '  symbols: ["URogueActionComponent.StartActionByName"]', 'confirmed_at: "2026-09-27T00:00:00Z"', "confirmed_by: tester", "",
].join("\n"));
const out = { head: git("rev-parse", "HEAD").trim() };
const init = duo(OLD, ["init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--repair"], "[]");
out.oldInit = { exitCode: init.exitCode, baseline: init.result?.baseline ?? null };
git("add", "-A"); git("commit", "-qm", "adopt");
out.old = { graph: graph(), unresolved: unresolved() };
edit(H, DECL, DECL.replace("AActor* Instigator", "AActor* InInstigator"));
out.old.reviewHeaderEdit = claims(duo(OLD, ["review", "--refresh"]));
reset();
duo(OLD, ["index"]);
// The older DUO's graph at the adopted commit (snapshot 1): the diff below compares it with this checkout's index.
out.old.indexedAtHead = graph();
// This checkout opens the repository indexed by the older DUO.
const status = duo(NEW, ["status"]);
out.new = { statusBefore: { index: status.result?.index?.status ?? status.result?.index ?? null, baseline: status.result?.baseline ?? null } };
const ctx = duo(NEW, ["context", "D-900"]);
out.new.contextBefore = ctx.result?.status ?? ctx.exitCode;
const idx = duo(NEW, ["index"]);
out.new.index = { mode: idx.result?.mode ?? null, fullRebuildReason: idx.result?.fullRebuildReason ?? null };
out.new.graph = graph(); out.new.unresolved = unresolved();
out.new.graphDiff = diff(rows.get(1), rows.get(2));
out.new.statusAfter = duo(NEW, ["status"]).result?.index?.status ?? null;
const ctx2 = duo(NEW, ["context", "D-900"]);
out.new.contextAfter = { status: ctx2.result?.status, items: (ctx2.result?.context?.packet?.code ?? []).filter((i) => i.id.endsWith("#URogueActionComponent.StartActionByName")).map((i) => i.text.split("\n")[0]) };
edit(H, DECL, DECL.replace("AActor* Instigator", "AActor* InInstigator"));
out.new.reviewHeaderEdit = claims(duo(NEW, ["review", "--refresh"]));
reset();
edit(C, BODY, BODY + " // probe");
out.new.reviewCppEdit = claims(duo(NEW, ["review", "--refresh"]));
edit(H, DECL, DECL.replace("AActor* Instigator", "AActor* InInstigator"));
out.new.reviewBoth = claims(duo(NEW, ["review", "--refresh"]));
reset();
duo(NEW, ["index"]);
console.log(JSON.stringify(out, null, 1));
fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });

