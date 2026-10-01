// T24.1 real-world probe (C217): every Symbol that merges overloads (payload.additionalLocations) in a pinned clone,
// asked for by its qualified name; does the Context Packet show each of its locations? Run it with the DUO build it
// belongs to (copy it into another checkout to measure that checkout's build). The clone is reset to its pinned commit.
//   node bench/experiments/overload-realworld.mjs <clone dir> [<clone dir> ...]      (needs pnpm build; clones from
//   node bench/realworld-suite.mjs --keep, default <OS temp>/duo-bench-repos/<id>)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));
const { createDefaultAnalyzerRegistry } = await import("@duo-director/analyzer");
const { canonicalSourceText } = await import("@duo-director/core");
const { dumpGraph, indexRepository, openProjectGraphStore } = await import("@duo-director/graph");
const { projectContext } = await import("@duo-director/integration");
const registry = (await createDefaultAnalyzerRegistry()).value;
const out = {};
for (const dir of process.argv.slice(2)) {
  const root = fs.realpathSync(dir);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  git("checkout", "--force", "-q", "HEAD"); git("clean", "-ffdxq");
  spawnSync(process.execPath, [CLI, "init", "--non-interactive", "--answers", "-", "--baseline-policy", "head", "--json"], { cwd: root, input: "[]", encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const store = openProjectGraphStore(root).value;
  let merged;
  try {
    await indexRepository(root, { store, registry });
    merged = dumpGraph(store).nodes.map((n) => JSON.parse(n)).filter((n) => n.id.startsWith("sym:") && (n.payload?.additionalLocations ?? []).length > 0);
  } finally { store.close(); }
  const files = new Map();
  const lineOf = (loc) => {
    if (!files.has(loc.path)) files.set(loc.path, canonicalSourceText(fs.readFileSync(path.join(root, loc.path), "utf8")).split("\n"));
    return (files.get(loc.path)[loc.startLine - 1] ?? "").trim();
  };
  const rows = [];
  for (const n of merged) {
    const locs = [n.source, ...n.payload.additionalLocations];
    const op = await projectContext(root, { task: n.payload.qualifiedName }, { registry });
    const item = op.kind === "ok" ? [...(op.payload?.context?.packet?.code ?? [])].find((c) => c.id === n.id) : undefined;
    const shown = item === undefined ? 0 : locs.filter((l) => item.text.includes(lineOf(l))).length;
    rows.push({ id: n.id, locations: locs.length, status: op.kind === "ok" ? op.payload?.status : op.kind, level: item?.level ?? null, shown });
  }
  const inPacket = rows.filter((r) => r.level !== null);
  out[path.basename(root)] = {
    sha: git("rev-parse", "HEAD"), mergedSymbols: rows.length, locations: rows.reduce((s, r) => s + r.locations, 0),
    inPacket: inPacket.length, byLevel: Object.fromEntries(["L1", "L2", "L3"].map((l) => [l, inPacket.filter((r) => r.level === l).length])),
    allLocationsShown: inPacket.filter((r) => r.shown === r.locations).length, locationsShown: inPacket.reduce((s, r) => s + r.shown, 0),
    locationsOfPacketSymbols: inPacket.reduce((s, r) => s + r.locations, 0), rows,
  };
  git("checkout", "--force", "-q", "HEAD"); git("clean", "-ffdxq");
}
console.log(JSON.stringify(out, null, 1));
