// T24.2 probe (C219): the Context Packet of one task in a pinned clone, by language: which files, at what level, how
// many tokens; and the repository's IMPORTS edges by source language and resolution status. Run it with the DUO build it
// belongs to (copy it into another checkout to measure that build). The clone is reset to its pinned commit.
//   node bench/experiments/context-language-share.mjs <clone dir> "<task>" ["<task>" ...]      (needs pnpm build)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { dumpGraph, indexRepository, openProjectGraphStore } = await import("@duo-director/graph");
const { projectContext } = await import("@duo-director/integration");
const registry = (await createDefaultAnalyzerRegistry()).value;
const [dir, ...tasks] = process.argv.slice(2);
const root = fs.realpathSync(dir);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
git("checkout", "--force", "-q", "HEAD"); git("clean", "-ffdxq");
spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8", maxBuffer: 1 << 28 });
const store = openProjectGraphStore(root).value;
let imports;
try {
  await indexRepository(root, { store, registry });
  const edges = dumpGraph(store).edges.map((e) => JSON.parse(e)).filter((e) => e.type === "IMPORTS");
  const lang = (id) => (/\.py$/u.test(id) ? "python" : /\.[cm]?[jt]sx?$/u.test(id) ? "typescript" : "other");
  imports = {};
  for (const e of edges) { const k = lang(e.from); imports[k] = (imports[k] ?? 0) + 1; }
  imports.pythonPairs = edges.filter((e) => lang(e.from) === "python").map((e) => e.from.slice(5) + " -> " + e.to.slice(5)).sort();
} finally { store.close(); }
const ext = (p) => (/\.py$/u.test(p) ? "python" : /\.[cm]?[jt]sx?$/u.test(p) ? "typescript" : "other");
const contexts = {};
for (const task of tasks) {
  const op = await projectContext(root, { task }, { registry });
  const packet = op.kind === "ok" ? op.payload?.context?.packet : undefined;
  const items = packet === undefined ? [] : [...packet.code, ...packet.tests];
  const byLanguage = {};
  // A File item (L1: path and language) has no source; its ref is the path.
  const pathOf = (i) => i.source?.path ?? (i.kind === "file" ? i.ref : undefined) ?? String(i.ref ?? "").split("#")[0];
  for (const i of items) {
    const k = ext(pathOf(i));
    const b = (byLanguage[k] ??= { items: 0, tokens: 0, L3: 0, L2: 0, L1: 0 });
    b.items++; b.tokens += i.tokens ?? 0; b[i.level] = (b[i.level] ?? 0) + 1;
  }
  contexts[task] = {
    status: op.payload?.status ?? op.kind, budget: packet?.budget ?? null, used: packet?.usedTokens ?? packet?.tokens ?? null, byLanguage,
    files: Object.fromEntries([...new Set(items.map(pathOf).filter((p) => p.endsWith(".py")))].sort().map((p) => [p, [...new Set(items.filter((i) => pathOf(i) === p).map((i) => i.level))].sort().join("+")])),
    omitted: packet?.omittedCandidates?.length ?? null,
  };
}
git("checkout", "--force", "-q", "HEAD"); git("clean", "-ffdxq");
console.log(JSON.stringify({ sha: git("rev-parse", "HEAD"), imports, contexts }, null, 1));
