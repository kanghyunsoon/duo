import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository } from "./indexer.js";
import { baseRegistry, cleanRebuild, invariantProblems, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

/** Deterministic PRNG (mulberry32) so a failing sequence can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Module {
  exports: string[];
  imports: { from: string; name: string; viaPaths: boolean }[];
  reexport?: string;
  body: number;
  broken: boolean;
}

const WINDOW = 5;
const STEPS = 18;
const SEED = 20260927;
const temps: string[] = [];
let base: AnalyzerRegistry;
let repo: TestRepo;
let store: GraphStore;
const modules = new Map<string, Module>();
let pathsTarget = "./src/*";
let counter = 0;

function render(m: Module): string {
  const lines: string[] = [];
  m.imports.forEach((imp, i) => lines.push(`import { ${imp.name} as i${i} } from "${imp.viaPaths ? "@m" : "."}/${imp.from}.js";`));
  if (m.reexport !== undefined) lines.push(`export * from "./${m.reexport}.js";`);
  const calls = m.imports.map((_, i) => `i${i}()`).join(" + ") || "0";
  for (const fn of m.exports) lines.push(`export function ${fn}(): number {\n  return ${calls} + ${m.body};\n}`);
  if (m.broken) lines.push("export function broken( {");
  return `${lines.join("\n")}\n`;
}

function writeAll(): void {
  for (const [file, m] of modules) repo.write(`src/${file}.ts`, render(m));
  repo.write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", paths: { "@m/*": [pathsTarget] } } }, null, 2));
}

beforeAll(async () => {
  base = await baseRegistry();
  for (let i = 0; i < 5; i++) modules.set(`m${i}`, { exports: [`f${i}`], imports: i === 0 ? [] : [{ from: `m${i - 1}`, name: `f${i - 1}`, viaPaths: i % 2 === 0 }], body: 0, broken: false });
  const files: Record<string, string> = {
    ".duo-project/project.yaml": "schema_version: 1\nname: fuzz\n",
    ".duo-project/specs/fuzz.md": "# Fuzz\n\n## FZ-01 Core\n\n```duo\nstatus: planned\nimplements:\n  paths: [\"src/m0.ts\"]\n  symbols: [f1]\n```\n\nCore.\n",
    "package.json": JSON.stringify({ name: "fuzz", private: true, type: "module" }),
  };
  repo = makeRepo(temps, files);
  writeAll();
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "FZ-01 modules");
  store = memoryStore();
});
afterAll(() => {
  store?.close();
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

type Mutation = (rnd: () => number) => string | undefined;
const pick = <T>(rnd: () => number, list: readonly T[]): T | undefined => list[Math.floor(rnd() * list.length)];
const files = () => [...modules.keys()].sort();

const MUTATIONS: Mutation[] = [
  (rnd) => { const f = pick(rnd, files()); if (f === undefined) return undefined; modules.get(f)!.body++; return `body ${f}`; },
  (rnd) => { const f = pick(rnd, files()); if (f === undefined) return undefined; modules.get(f)!.exports.push(`e${++counter}`); return `add export ${f}`; },
  (rnd) => { const f = pick(rnd, files().filter((x) => modules.get(x)!.exports.length > 0)); if (f === undefined) return undefined; const m = modules.get(f)!; m.exports.splice(Math.floor(rnd() * m.exports.length), 1); return `remove export ${f}`; },
  (rnd) => {
    const a = pick(rnd, files());
    const b = pick(rnd, [...files(), "ghost"]);
    if (a === undefined || b === undefined || a === b) return undefined;
    const name = pick(rnd, [...(modules.get(b)?.exports ?? []), "nothing"]) ?? "nothing";
    modules.get(a)!.imports.push({ from: b, name, viaPaths: rnd() < 0.5 });
    return `import ${a} <- ${b}.${name}`;
  },
  (rnd) => { const f = pick(rnd, files().filter((x) => modules.get(x)!.imports.length > 0)); if (f === undefined) return undefined; const m = modules.get(f)!; m.imports.splice(Math.floor(rnd() * m.imports.length), 1); return `remove import ${f}`; },
  () => { const f = `n${++counter}`; modules.set(f, { exports: [`g${counter}`], imports: [], body: 0, broken: false }); return `add file ${f}`; },
  (rnd) => { const f = pick(rnd, files()); if (f === undefined || modules.size < 3) return undefined; modules.delete(f); repo.remove(`src/${f}.ts`); return `delete ${f}`; },
  (rnd) => {
    const f = pick(rnd, files());
    if (f === undefined) return undefined;
    const to = `r${++counter}`;
    modules.set(to, modules.get(f)!);
    modules.delete(f);
    repo.rename(`src/${f}.ts`, `src/${to}.ts`);
    return `rename ${f} -> ${to}`;
  },
  (rnd) => { const a = pick(rnd, files()); const b = pick(rnd, files()); if (a === undefined || b === undefined) return undefined; const m = modules.get(a)!; if (m.reexport === undefined && a !== b) m.reexport = b; else delete m.reexport; return `reexport ${a} -> ${m.reexport ?? "none"}`; },
  () => { pathsTarget = pathsTarget === "./src/*" ? "./lib/*" : "./src/*"; return `paths -> ${pathsTarget}`; },
  (rnd) => { const f = pick(rnd, files()); if (f === undefined) return undefined; const m = modules.get(f)!; m.broken = !m.broken; return `syntax ${m.broken ? "broken" : "fixed"} ${f}`; },
  () => { repo.git("add", "-A"); repo.git("commit", "-q", "--allow-empty", "-m", `FZ-01 step ${++counter}`); return "commit"; },
];

describe("AC-008-01 random change sequences (seeded) stay equal to a clean full rebuild", () => {
  it(`seed ${SEED}, ${STEPS} steps`, async () => {
    const rnd = prng(SEED);
    const first = await indexRepository(repo.root, { store, registry: base, historyWindow: WINDOW });
    expect(first.value?.mode).toBe("full");
    const applied: string[] = [];
    for (let s = 0; s < STEPS; s++) {
      for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) {
        const label = pick(rnd, MUTATIONS)?.(rnd);
        if (label !== undefined) applied.push(`${s}: ${label}`);
      }
      writeAll();
      const r = await indexRepository(repo.root, { store, registry: base, historyWindow: WINDOW });
      if (r.value === undefined) throw new Error(`step ${s} failed: ${JSON.stringify(r.diagnostics)}\n${applied.join("\n")}`);
      expect(r.value.mode, applied.join("\n")).toBe("incremental");
      expect(dumpGraph(store), applied.join("\n")).toEqual(await cleanRebuild(repo.root, base, WINDOW));
      expect(invariantProblems(store, repo.root)).toEqual([]);
    }
    expect(applied.length).toBeGreaterThanOrEqual(STEPS);
  });
});

