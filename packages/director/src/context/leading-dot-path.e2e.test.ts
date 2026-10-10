/**
 * C256 (T54): a task path whose first directory starts with a dot (".github/workflows/ci.yml") is an exact path seed
 * like any other repository path: the word keeps its leading dots when it has a separator and core normalizeRepoPath
 * decides. A root file without a separator ("package.json") is still not a path signal (separate policy).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPathSignal } from "./seeds.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const decision = (id: string, title: string, answer: string, paths: string[]) =>
  `id: ${id}\ntitle: ${title}\nkind: decision\nstate: proposed\nquestion: ${id.toLowerCase()}_rule\nanswer: ${answer}\ngoverns:\n  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]\nenforcement: warn\n`;

function writeFixture(dir: string): void {
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w("package.json", JSON.stringify({ name: "c256", version: "1.0.0", type: "module" }) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }) + "\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: c256\n");
  w(".duo-project/decisions/D-001.yaml", decision("D-001", "CI runs on every push", "the ci workflow runs lint and tests", [".github/**"]));
  w(".duo-project/decisions/D-002.yaml", decision("D-002", "Workflow runner is pinned", "the github workflow runner image is pinned", ["src/other/**"]));
  w(".github/workflows/ci.yml", "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n");
  w(".config/tool/settings.json", "{\"tool\": true}\n");
  w("..cache/file.ts", "export const cached = 1;\n");
  w("src/.generated/file.ts", "export const generated = 1;\n");
  w("src/other/github-workflow-ci.ts", "export function githubWorkflowCi(): string {\n  return \"ci\";\n}\n");
}

const seeds = (r: ContextResult) => r.packet?.seeds.map((s) => [s.ref, s.match]) ?? [];
const active = (r: ContextResult) => r.packet?.decisions.active.map((d) => d.ref).sort() ?? [];
const CI = ".github/workflows/ci.yml";

describe("leading-dot directory paths are exact path seeds (C256, T54)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-c256-"));
    temps.push(fixture);
    writeFixture(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    const s = createDecisionService({ root: repo.root, clock: () => new Date("2026-10-10T00:00:00Z") });
    for (const id of ["D-001", "D-002"]) expect((await s.confirm({ kind: "human", name: "Ada" }, id)).value?.decisionId).toBe(id);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "decisions");
    await repo.index();
  });
  afterAll(() => registry?.dispose());

  it("1-5 every spelling is the same exact File; D-001 only (before: keyword seeds and D-002 through githubWorkflowCi)", async () => {
    for (const task of [CI, "./" + CI, ".github\\workflows\\ci.yml", ".\\.github\\workflows\\ci.yml", "Modify .github/workflows/ci.yml.", "Modify .github\\workflows\\ci.yml."]) {
      const r = await repo.compile({ task, budget: 6000 });
      expect(seeds(r), task).toEqual([[CI, "path"]]);
      expect(active(r), task).toEqual(["D-001"]);
    }
    const r = await repo.compile({ task: ".github\\workflows\\ci.yml", budget: 6000 });
    expect(r.packet?.seeds[0]?.term).toBe(".github\\workflows\\ci.yml");
  });

  it("6 a dot directory deeper in the path is unchanged; other first dot directories resolve too", async () => {
    for (const p of ["src/.generated/file.ts", ".config/tool/settings.json", "..cache/file.ts"]) expect(seeds(await repo.compile({ task: p, budget: 6000 })), p).toEqual([[p, "path"]]);
  });

  it("7-9 a missing hidden File, absolute, UNC and escaping spellings are not exact paths", async () => {
    for (const task of [".github/workflows/missing.yml", "/" + CI, "C:\\repo\\.github\\workflows\\ci.yml", "\\\\server\\share\\.github\\ci.yml", "../" + CI, "src/../../" + CI]) {
      const r = await repo.compile({ task, budget: 6000 });
      expect(r.packet?.seeds.some((s) => s.match === "path"), task).toBe(false);
    }
  });

  it("10 the exact hidden path is not BM25 input; the user's other words still are", async () => {
    const r = await repo.compile({ task: "Modify .github/workflows/ci.yml", budget: 6000 });
    expect(seeds(r)).toEqual([[CI, "path"]]);
    const words = await repo.compile({ task: "Modify .github/workflows/ci.yml workflow runner", budget: 6000 });
    expect(seeds(words)[0]).toEqual([CI, "path"]);
    expect(words.packet?.seeds.some((s) => s.ref === "D-002" && s.match === "keyword")).toBe(true);
  });

  it("11-12 a bare root file stays a keyword word; ./ and .\\ root files stay exact", async () => {
    const bare = await repo.compile({ task: "package.json", budget: 6000 });
    expect(bare.packet?.seeds.some((s) => s.match === "path")).toBe(false);
    for (const task of ["./package.json", ".\\package.json"]) expect(seeds(await repo.compile({ task, budget: 6000 })), task).toEqual([["package.json", "path"]]);
  });

  it("13 isPathSignal agrees with resolution", () => {
    for (const p of [CI, "./" + CI, ".github\\workflows\\ci.yml", ".\\.github\\workflows\\ci.yml", "src/.generated/file.ts", "./package.json", "..cache/file.ts"]) expect(isPathSignal(p), p).toBe(true);
    for (const p of ["package.json", ".env", "/" + CI, "C:\\repo\\.github\\ci.yml", "../" + CI, "src/../../" + CI, CI + "."]) expect(isPathSignal(p), p).toBe(false);
  });

  it("14 cache: policy 7 packets miss first, then hit with the same bytes", async () => {
    const a = await repo.compile({ task: CI, budget: 6000 }, { cache: true });
    const b = await repo.compile({ task: CI, budget: 6000 }, { cache: true });
    expect(a.cache.status).toBe("miss");
    expect(b.cache.status).toBe("hit");
    expect(JSON.stringify(b.packet)).toBe(JSON.stringify(a.packet));
  });
});
