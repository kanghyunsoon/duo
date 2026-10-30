/**
 * Issue #49 forbidden imports through re-exports (Maintainer Decision L1-C).
 *
 * Stage 2 (H-98, Jira S15P31A106-347): when every name a changed import takes is traced to exactly one origin
 * binding and an origin file is in forbids.imported_paths, the import is a `forbidden-import` claim on the
 * source → origin pair (the same key as a direct import of that file, H-72 (10)), with the re-export chain
 * as evidence. With an Adoption Baseline that evaluated re-export origins (marker
 * `decision-forbids-import-origin`) a new pair is `introduced` (BLOCK); with an older baseline it is
 * `unverified-at-adoption` (WARN) with the `imports-reexport-origin-not-baselined` limitation. Without any
 * baseline it is the same as a direct import: the claim has no provenance and is BLOCK-eligible.
 *
 * Stage 1 (#124, Jira S15P31A106-346): anything ambiguous keeps the `imports-through-reexport` limitation with
 * the chain and no claim: namespace and side-effect imports of a barrel (every name), `export * as ns`, a name
 * that more than one `export *` module provides, cycles and chains longer than MAX_REEXPORT_DEPTH (4).
 * Import-then-export is not followed in either stage.
 *
 * - Only the names the import takes are traced, so an unrelated name from the same barrel is not reported.
 *   `export *` forwards every name but "default".
 * - A direct import of a forbidden file is still the H-72 claim, with no extra limitation.
 * - With forbids.importer_paths (#47, H-96 (2)), an importer outside the filter gets neither the claim nor
 *   the limitation for that Decision.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService, fileRef, nodeId, type RepoPath } from "@duo-director/core";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureAdoptionBaseline, loadAdoptionBaseline } from "../adoption/baseline.js";
import { violationKey } from "../adoption/key.js";
import type { AdoptionBaselineRecord } from "../adoption/types.js";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { historyRecordId, REVIEWS_DIR } from "./record.js";
import { reviewChanges } from "./review.js";
import type { ReviewClaim, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const human = { kind: "human" as const, name: "Ada" };
const at = (iso: string) => () => new Date(iso);
const W = { from: "HEAD" as const, to: "WORKTREE" as const };
const LEGACY = "src/db/legacy-db.ts";
const pairKey = (source: string, target = LEGACY) =>
  violationKey("decision-forbids-import", "D-001", `import:${nodeId(fileRef(source as RepoPath))}->${nodeId(fileRef(target as RepoPath))}`);

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
  "src/db/legacy-copy.ts": "export function legacyQuery(sql: string): string {\n  return sql.trim();\n}\n",
  "src/db/date.ts": "export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n",
  "src/db/index.ts": reexport("./legacy-db.js") + reexport("./date.js", "formatDate"),
  "src/db/all.ts": 'export * from "./legacy-db.js";\nexport * from "./date.js";\n',
  // Two `export *` modules provide legacyQuery: ambiguous.
  "src/db/both.ts": 'export * from "./legacy-db.js";\nexport * from "./legacy-copy.js";\n',
  "src/db/alias.ts": reexport("./legacy-db.js", "legacyQuery as query"),
  "src/db/ns.ts": 'export * as legacy from "./legacy-db.js";\n',
  // Import-then-export: not followed.
  "src/db/relay.ts": 'import { legacyQuery } from "./legacy-db.js";\n\nexport { legacyQuery };\n',
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
  // Already imports legacy-db through the barrel when the baseline is captured.
  "src/ui/old-page.ts": 'import { legacyQuery } from "../db/index.js";\n\nexport const oldPage = (): string => legacyQuery("old");\n',
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

async function confirmedRepo(from: string, ids: readonly string[] = ["D-001"]): Promise<ContextRepo> {
  const repo = makeContextRepo(temps, registry, from);
  for (const id of ids) {
    const c = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, id);
    if (c.value === undefined) throw new Error(JSON.stringify(c.diagnostics));
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "confirm Decisions");
  return repo;
}

async function adoptedRepo(from: string, ids: readonly string[] = ["D-001"]): Promise<{ repo: ContextRepo; baseline: AdoptionBaselineRecord }> {
  const repo = await confirmedRepo(from, ids);
  await repo.index();
  const b = await withGraph(repo.root, (graph) =>
    captureAdoptionBaseline(repo.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at("2026-09-02T00:00:00.000Z") }),
  );
  if (b.value === undefined || b.value.status === "aborted") throw new Error(JSON.stringify(b));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "capture adoption baseline");
  const baseline = loadAdoptionBaseline(repo.root).baseline;
  if (baseline === undefined) throw new Error("no baseline");
  return { repo, baseline };
}

async function write(repo: ContextRepo, file: string, text: string): Promise<ReviewResult> {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
  repo.write(file, text);
  return review(repo);
}

/** One forbidden-import claim on `source` → legacy-db, the verdict, and no imports-* limitation. */
function expectClaim(res: ReviewResult, source: string, provenance: ReviewClaim["provenance"], verdict: ReviewResult["verdict"]): ReviewClaim {
  expect(res.verdict).toBe(verdict);
  const claims = forbiddenImports(res);
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({ alignment: "CONFLICT", reason: "forbidden-import", provenance, violationKey: pairKey(source) });
  return claims[0] as ReviewClaim;
}

describe("Issue #49 Stage 2 (H-98): exact re-export origins with an origin-evaluated baseline", () => {
  let repo: ContextRepo;
  let baseline: AdoptionBaselineRecord;

  beforeAll(async () => {
    ({ repo, baseline } = await adoptedRepo(fixture));
  });

  const page = (text: string): Promise<ReviewResult> => write(repo, "src/ui/page.ts", text);
  const expectBlock = (res: ReviewResult) => {
    const c = expectClaim(res, "src/ui/page.ts", "introduced", "BLOCK");
    expect(c.blockEligible).toBe(true);
    expect(importLimits(res)).toEqual([]);
    return c;
  };
  /** Stage 1: the limitation is the only imports-* entry, the verdict stays PASS and nothing is claimed. */
  const expectLimitation = (res: ReviewResult, chain: string) => {
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res).map((l) => l.code)).toEqual(["imports-through-reexport"]);
    expect(throughReexport(res)[0]?.message).toContain(`${chain} (D-001)`);
  };
  const expectNothing = (res: ReviewResult) => {
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual([]);
  };

  it("the baseline records the origin marker and the pair src/ui/old-page.ts already had through the barrel", () => {
    expect(baseline.evaluatedRules).toContain("decision-forbids-import-origin");
    expect(baseline.findings.map((f) => f.key)).toContain(pairKey("src/ui/old-page.ts"));
  });

  it("a named import whose origin is legacy-db: forbidden-import on the source → origin pair, introduced, BLOCK, with the chain", async () => {
    const res = await page('import { legacyQuery } from "../db/index.js";\n');
    const c = expectBlock(res);
    expect(c.observed).toContain('src/ui/page.ts:1 import "../db/index.js" re-exports legacyQuery from src/db/legacy-db.ts via src/db/index.ts');
    // Evidence: the changed import and the export-from statement in the barrel.
    const refs = c.evidenceIds.map((id) => res.evidence.find((e) => e.id === id)).filter((e) => e?.metadata?.moduleReference !== undefined);
    expect(refs.map((e) => e?.pointer.path).sort()).toEqual(["src/db/index.ts", "src/ui/page.ts"]);
  });

  it("an unrelated name from the same barrel is not reported", async () => {
    expectNothing(await page('import { formatDate } from "../db/index.js";\n'));
  });

  it("side-effect and namespace imports of the barrel take every name: Stage 1 limitation, no claim", async () => {
    expectLimitation(await page('import "../db/index.js";\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
    expectLimitation(await page('import * as db from "../db/index.js";\n\nexport const q = db.legacyQuery;\n'), "src/ui/page.ts:1 → src/db/index.ts → src/db/legacy-db.ts");
  });

  it("export *: one provider is exact (legacyQuery BLOCK, formatDate from date.ts nothing, default nothing); two providers stay the limitation", async () => {
    expectBlock(await page('import { legacyQuery } from "../db/all.js";\n'));
    expectNothing(await page('import { formatDate } from "../db/all.js";\n'));
    expectNothing(await page('import all from "../db/all.js";\n\nexport const x = all;\n'));
    expectLimitation(await page('import { legacyQuery } from "../db/both.js";\n'), "src/ui/page.ts:1 → src/db/both.ts → src/db/legacy-db.ts");
  });

  it("type-only imports are included (H-72 (3)): import type through export * is BLOCK", async () => {
    expectBlock(await page('import type { LegacyRow } from "../db/all.js";\n\nexport type Row = LegacyRow;\n'));
  });

  it("an aliased re-export is traced by its original name; export * as ns stays the limitation", async () => {
    expectBlock(await page('import { query } from "../db/alias.js";\n'));
    expectNothing(await page('import { legacyQuery } from "../db/alias.js";\n'));
    expectLimitation(await page('import { legacy } from "../db/ns.js";\n'), "src/ui/page.ts:1 → src/db/ns.ts → src/db/legacy-db.ts");
  });

  it("a changed export-from in the reviewed file is traced like an import", async () => {
    expectBlock(await page('export { legacyQuery } from "../db/index.js";\n'));
  });

  it("at most MAX_REEXPORT_DEPTH (4) hops: 4 hops BLOCK, 5 hops and a cycle report nothing", async () => {
    const c = expectBlock(await page('import { legacyQuery } from "../db/hop1.js";\n'));
    expect(c.observed).toContain("via src/db/hop1.ts → src/db/hop2.ts → src/db/hop3.ts → src/db/hop4.ts");
    expectNothing(await page('import { legacyQuery } from "../db/far1.js";\n'));
    expectNothing(await page('import { legacyQuery } from "../db/cycle-a.js";\n'));
  });

  it("import-then-export is not followed: no claim, no limitation", async () => {
    expectNothing(await page('import { legacyQuery } from "../db/relay.js";\n'));
  });

  it("a direct import of legacy-db is still the H-72 claim (BLOCK) with no extra limitation", async () => {
    const c = expectBlock(await page('import { legacyQuery } from "../db/legacy-db.js";\n'));
    expect(c.observed).toContain("resolves to src/db/legacy-db.ts");
  });

  it("an edit to the import that was in the baseline through the barrel is pre-existing-touched, WARN", async () => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    repo.edit("src/ui/old-page.ts", "import { legacyQuery }", "import { legacyQuery, formatDate }");
    const c = expectClaim(await review(repo), "src/ui/old-page.ts", "pre-existing-touched", "WARN");
    expect(c.blockEligible).toBe(false);
  });
});

describe("Issue #49 Stage 2 (H-98 (5)): a baseline recorded before re-export origins were evaluated", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    ({ repo } = await adoptedRepo(fixture));
    // The same baseline as a capture before Stage 2 would have written it: no origin marker and no pairs
    // found only through re-exports; the record id is recomputed.
    const loaded = loadAdoptionBaseline(repo.root);
    const file = path.join(repo.root, loaded.path ?? "");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & { evaluatedRules: string[]; findings: { key: string }[] };
    const rest: Record<string, unknown> = { ...record };
    const recorded = rest.recorded;
    delete rest.id;
    delete rest.recorded;
    const body = {
      ...rest,
      evaluatedRules: record.evaluatedRules.filter((r) => r !== "decision-forbids-import-origin"),
      findings: record.findings.filter((f) => f.key !== pairKey("src/ui/old-page.ts")),
    };
    const id = historyRecordId("adoption", body);
    fs.rmSync(file);
    fs.writeFileSync(path.join(repo.root, REVIEWS_DIR, `${id}.json`), `${JSON.stringify({ id, recorded, ...body }, null, 2)}\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "baseline from before #49 Stage 2");
    expect(loadAdoptionBaseline(repo.root)).toMatchObject({ status: "present", baseline: { id } });
  });

  it("a new pair through the barrel is unverified-at-adoption, not BLOCK-eligible, WARN, with the limitation", async () => {
    const res = await write(repo, "src/ui/page.ts", 'import { legacyQuery } from "../db/index.js";\n');
    const c = expectClaim(res, "src/ui/page.ts", "unverified-at-adoption", "WARN");
    expect(c.blockEligible).toBe(false);
    expect(importLimits(res).map((l) => l.code)).toEqual(["imports-reexport-origin-not-baselined"]);
    expect(importLimits(res)[0]?.message).toContain("src/ui/page.ts → src/db/legacy-db.ts (D-001)");
  });

  it("a direct import is still judged by the decision-forbids-import coverage: introduced, BLOCK", async () => {
    const res = await write(repo, "src/ui/page.ts", 'import { legacyQuery } from "../db/legacy-db.js";\n');
    expectClaim(res, "src/ui/page.ts", "introduced", "BLOCK");
    expect(importLimits(res)).toEqual([]);
  });
});

describe("Issue #49 Stage 2 (H-98 (1)(2)) without an Adoption Baseline", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = await confirmedRepo(fixture);
  });

  it("a named import through the barrel is the same as a direct import of the origin: claim, BLOCK, no provenance", async () => {
    const res = await write(repo, "src/ui/page.ts", 'import { legacyQuery } from "../db/index.js";\n');
    expect(res.baseline.status).toBe("missing");
    expect(res.verdict).toBe("BLOCK");
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ alignment: "CONFLICT", reason: "forbidden-import", violationKey: pairKey("src/ui/page.ts"), blockEligible: true });
    expect(claims[0]).not.toHaveProperty("provenance");
    expect(importLimits(res)).toEqual([]);
  });
});

describe("Issue #49 with forbids.importer_paths (#47, H-96 (2), H-98 (3))", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    const scoped = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue49-scoped-")));
    temps.push(scoped);
    fs.cpSync(fixture, scoped, { recursive: true });
    fs.writeFileSync(path.join(scoped, ".duo-project/decisions/D-001.yaml"), D001("src/ui/**"));
    // D-002 has no importer filter, so every changed file is still checked: the services file below is
    // reviewed for D-002 and must get neither D-001's claim nor its limitation.
    fs.writeFileSync(
      path.join(scoped, ".duo-project/decisions/D-002.yaml"),
      D001().replace("D-001", "D-002").replace("legacy_db_import", "date_import").replace("src/db/legacy-db.ts]", "src/db/date.ts]"),
    );
    ({ repo } = await adoptedRepo(scoped, ["D-001", "D-002"]));
  });

  it("an importer outside importer_paths gets no claim and no limitation for that Decision", async () => {
    const res = await write(repo, "src/services/report.ts", 'import { legacyQuery } from "../db/index.js";\n');
    expect(res.verdict).toBe("PASS");
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual([]);
    // A namespace import takes every name: only D-002's limitation (the barrel re-exports date.ts), none for D-001.
    const ns = await write(repo, "src/services/report.ts", 'import * as db from "../db/index.js";\n\nexport const q = db.legacyQuery;\n');
    expect(importLimits(ns).map((l) => l.code)).toEqual(["imports-through-reexport"]);
    expect(throughReexport(ns)[0]?.message).toContain("src/services/report.ts:1 → src/db/index.ts → src/db/date.ts (D-002)");
    expect(throughReexport(ns)[0]?.message).not.toContain("D-001");
  });

  it("the same import in a file matching importer_paths is the claim (BLOCK); a namespace import is the limitation", async () => {
    expectClaim(await write(repo, "src/ui/report.ts", 'import { legacyQuery } from "../db/index.js";\n'), "src/ui/report.ts", "introduced", "BLOCK");
    const ns = await write(repo, "src/ui/report.ts", 'import * as db from "../db/index.js";\n\nexport const q = db.legacyQuery;\n');
    expect(importLimits(ns).map((l) => l.code)).toEqual(["imports-through-reexport"]);
    expect(throughReexport(ns)[0]?.message).toContain("src/ui/report.ts:1 → src/db/index.ts → src/db/legacy-db.ts (D-001)");
  });
});
