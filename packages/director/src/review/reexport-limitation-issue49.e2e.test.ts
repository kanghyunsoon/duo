/**
 * Issue #49 Stage 1 (Maintainer Decision L1-C, Jira S15P31A106-346): a changed import that can reach a file in
 * forbids.imported_paths only through re-exports gets the `imports-through-reexport` limitation with the chain.
 * PASS/WARN/BLOCK/ASK do not change: binding origins are not verified (that is Stage 2, S15P31A106-347).
 *
 * - Only the names the import takes are followed through `export ... from`, so an unrelated name from the same
 *   barrel is not reported. `export *` forwards every name but "default", so a named import through it can
 *   reach every module it re-exports. Side-effect, namespace and dynamic imports take every name.
 * - At most MAX_REEXPORT_DEPTH (4) re-export hops; cycles stop. Import-then-export and local declarations are
 *   not followed.
 * - A direct import of a forbidden file is still the H-72 claim, with no extra limitation.
 * - With forbids.importer_paths (#47, H-96 (2)), an importer outside the filter gets neither the claim nor
 *   the limitation for that Decision.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureAdoptionBaseline } from "../adoption/baseline.js";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const human = { kind: "human" as const, name: "Ada" };
const at = (iso: string) => () => new Date(iso);
const W = { from: "HEAD" as const, to: "WORKTREE" as const };

const D001 = (importerPaths?: string) =>
  [
    "id: D-001",
    "title: Nothing imports legacy-db",
    "kind: decision",
    "state: proposed",
    "question: legacy_db_import",
    "answer: no code imports src/db/legacy-db.ts",
    "forbids:",
    "  imported_paths: [src/db/legacy-db.ts]",
    ...(importerPaths === undefined ? [] : [`  importer_paths: [${importerPaths}]`]),
    "enforcement: block",
    "",
  ].join("\n");
const reexport = (from: string, names = "legacyQuery") => `export { ${names} } from "${from}";\n`;
const FILES: Record<string, string> = {
  "package.json": '{ "name": "issue49-reexport-fixture", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true, "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: issue49-reexport-fixture\n",
  ".duo-project/decisions/D-001.yaml": D001(),
  "src/db/legacy-db.ts": "export type LegacyRow = string;\n\nexport function legacyQuery(sql: string): string {\n  return sql;\n}\n",
  "src/db/date.ts": "export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n",
  "src/db/index.ts": reexport("./legacy-db.js") + reexport("./date.js", "formatDate"),
  "src/db/all.ts": 'export * from "./legacy-db.js";\nexport * from "./date.js";\n',
  "src/db/alias.ts": reexport("./legacy-db.js", "legacyQuery as query"),
  "src/db/ns.ts": 'export * as legacy from "./legacy-db.js";\n',
  // 4 hops: hop1 -> hop2 -> hop3 -> hop4 -> legacy-db; 5 hops: far1 -> … -> far5 -> legacy-db.
  "src/db/hop1.ts": reexport("./hop2.js"),
  "src/db/hop2.ts": reexport("./hop3.js"),
  "src/db/hop3.ts": reexport("./hop4.js"),
  "src/db/hop4.ts": reexport("./legacy-db.js"),
  "src/db/far1.ts": reexport("./far2.js"),
  "src/db/far2.ts": reexport("./far3.js"),
  "src/db/far3.ts": reexport("./far4.js"),
  "src/db/far4.ts": reexport("./far5.js"),
  "src/db/far5.ts": reexport("./legacy-db.js"),
  "src/db/cycle-a.ts": reexport("./cycle-b.js"),
  "src/db/cycle-b.ts": reexport("./cycle-a.js"),
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue49-fixture-")));
  temps.push(fixture);
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true });
    fs.writeFileSync(path.join(fixture, f), text);
  }
});

afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

async function withGraph<T>(root: string, fn: (g: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    return await fn(opened.value);
  } finally {
    opened.value.close();
  }
}

async function review(r: ContextRepo): Promise<ReviewResult> {
  await r.index();
  return withGraph(r.root, async (graph) => {
    const out = await reviewChanges(r.root, { diff: W }, { graph, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  });
}

const forbiddenImports = (res: ReviewResult) => res.claims.filter((c) => c.rule === "decision-forbids-import");
const importLimits = (res: ReviewResult) => res.limitations.filter((l) => l.code.startsWith("imports-"));
const throughReexport = (res: ReviewResult) => res.limitations.filter((l) => l.code === "imports-through-reexport");

async function adoptedRepo(from: string, ids: readonly string[] = ["D-001"]): Promise<ContextRepo> {
  const repo = makeContextRepo(temps, registry, from);
  for (const id of ids) {
    const c = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, id);
    if (c.value === undefined) throw new Error(JSON.stringify(c.diagnostics));
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "confirm Decisions");
  await repo.index();
  const b = await withGraph(repo.root, (graph) =>
    captureAdoptionBaseline(repo.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at("2026-09-02T00:00:00.000Z") }),
  );
  if (b.value === undefined || b.value.status === "aborted") throw new Error(JSON.stringify(b));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "capture adoption baseline");
  return repo;
}

async function write(repo: ContextRepo, file: string, text: string): Promise<ReviewResult> {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
  repo.write(file, text);
  return review(repo);
}

describe("Issue #49 Stage 1: imports-through-reexport limitation (no verdict change)", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = await adoptedRepo(fixture);
  });

  const page = (text: string): Promise<ReviewResult> => write(repo, "src/ui/page.ts", text);
  /** The limitation is the only imports-* entry, the verdict stays PASS and nothing is claimed. */
  const expectLimitation = (res: ReviewResult, chain: string) => {
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res).map((l) => l.code)).toEqual(["imports-through-reexport"]);
    expect(throughReexport(res)[0]?.message).toContain(`${chain} (D-001)`);
    expect(throughReexport(res)[0]?.message).toContain("not checked binding by binding");
  };
  const expectNothing = (res: ReviewResult) => {
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual([]);
  };

  it("a named import whose name the barrel re-exports from legacy-db: limitation with the chain", async () => {
    expectLimitation(await page('import { legacyQuery } from "../db/index.js";\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
  });

  it("an unrelated name from the same barrel is not reported", async () => {
    expectNothing(await page('import { formatDate } from "../db/index.js";\n'));
  });

  it("side-effect and namespace imports of the barrel take every name: limitation", async () => {
    expectLimitation(await page('import "../db/index.js";\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
    expectLimitation(await page('import * as db from "../db/index.js";\n\nexport const q = db.legacyQuery;\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
  });

  it("export * forwards every name but default: a named import through it can reach legacy-db, default cannot", async () => {
    expectLimitation(await page('import { formatDate } from "../db/all.js";\n'), "src/ui/page.ts:1 → src/db/all.ts → src/db/legacy-db.ts");
    expectNothing(await page('import all from "../db/all.js";\n\nexport const x = all;\n'));
  });

  it("type-only imports are included (H-72 (3))", async () => {
    expectLimitation(await page('import type { LegacyRow } from "../db/all.js";\n\nexport type Row = LegacyRow;\n'), "src/ui/page.ts:1 → src/db/all.ts → src/db/legacy-db.ts");
  });

  it("follows the original name of an aliased re-export and export * as ns", async () => {
    expectLimitation(await page('import { query } from "../db/alias.js";\n'), "src/ui/page.ts:1 → src/db/alias.ts → src/db/legacy-db.ts");
    expectNothing(await page('import { legacyQuery } from "../db/alias.js";\n'));
    expectLimitation(await page('import { legacy } from "../db/ns.js";\n'), "src/ui/page.ts:1 → src/db/ns.ts → src/db/legacy-db.ts");
  });

  it("a changed export-from in the reviewed file is followed like an import", async () => {
    expectLimitation(await page('export { legacyQuery } from "../db/index.js";\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
  });

  it("follows at most MAX_REEXPORT_DEPTH (4) hops and stops at cycles", async () => {
    expectLimitation(await page('import { legacyQuery } from "../db/hop1.js";\n'), "src/ui/page.ts:1 → src/db/hop1.ts → src/db/hop2.ts → src/db/hop3.ts → src/db/hop4.ts → src/db/legacy-db.ts");
    expectNothing(await page('import { legacyQuery } from "../db/far1.js";\n'));
    expectNothing(await page('import { legacyQuery } from "../db/cycle-a.js";\n'));
  });

  it("a direct import of legacy-db is still the H-72 claim (BLOCK) with no re-export limitation", async () => {
    const res = await page('import { legacyQuery } from "../db/legacy-db.js";\n');
    expect(res.verdict).toBe("BLOCK");
    expect(forbiddenImports(res)).toHaveLength(1);
    expect(importLimits(res)).toEqual([]);
  });
});

describe("Issue #49 Stage 1 with forbids.importer_paths (#47, H-96 (2))", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    const scoped = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue49-scoped-")));
    temps.push(scoped);
    fs.cpSync(fixture, scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, ".duo-project/decisions/D-001.yaml"), D001("src/ui/**"));
    // D-002 has no importer filter, so every changed file is still checked: the services file below is
    // reviewed for D-002 and must not get D-001's limitation.
    fs.writeFileSync(
      path.join(scoped, ".duo-project/decisions/D-002.yaml"),
      D001().replace("D-001", "D-002").replace("legacy_db_import", "date_import").replace("src/db/legacy-db.ts]", "src/db/date.ts]"),
    );
    repo = await adoptedRepo(scoped, ["D-001", "D-002"]);
  });

  const barrelImport = 'import { legacyQuery } from "../db/index.js";\n';

  it("an importer outside importer_paths gets no re-export limitation for that Decision", async () => {
    const res = await write(repo, "src/services/report.ts", barrelImport);
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual([]);
  });

  it("the same import in a file matching importer_paths gets the limitation", async () => {
    const res = await write(repo, "src/ui/report.ts", barrelImport);
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res).map((l) => l.code)).toEqual(["imports-through-reexport"]);
    expect(throughReexport(res)[0]?.message).toContain("src/ui/report.ts:1 → src/db/index.ts → src/db/legacy-db.ts (D-001)");
  });
});
