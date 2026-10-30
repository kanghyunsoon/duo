/**
 * Issue #48 ([VAL-05] Adoption provenance for repeated forbidden imports — follow-up of #30 D3,
 * Jira S15P31A106-265).
 *
 * The maintainer direction on #48 keeps H-72 (10) (one violation per source→target file pair) and
 * H-73 (3) (`introduced` means the key is not in the Adoption Baseline), and asks for test-only
 * fixtures that pin today's behavior for the cases below before any policy change.
 *
 * Fixture: D-001 forbids `src/db/legacy-db.ts` (`enforcement: block`), confirmed before an Adoption
 * Baseline captured at a clean HEAD, so every UI file that imports `legacy-db` at HEAD is a baseline
 * pair. `src/ui/archive-page.ts` imports a file that does not exist at HEAD (no pair in the baseline).
 *
 * Pinned reproduction fixtures (P1–P8, N1):
 * - P1: A new name is added to an existing import (`{ legacyQuery }` → `{ legacyQuery, legacyCount }`).
 * - P2: A second import statement of a name that is already imported (D3 in #30).
 * - P3: One import with two names is split into two statements.
 * - P4: Two import statements are merged into one.
 * - P5: Only the local alias changes (`{ legacyQuery }` → `{ legacyQuery as query }`).
 * - P6a / P6b: type-only → value import, and value → type-only import.
 * - P7a: The specifier changes to a `tsconfig` path alias that resolves to the same file.
 *   All of P1–P7a: current `next` behavior is one `pre-existing-touched` CONFLICT on the pair key,
 *   `blockEligible: false`, WARN.
 * - P7b: The specifier changes to the barrel `src/db/index.ts` that re-exports `legacy-db`. Since #49
 *   Stage 2 (H-98): `legacyQuery` is traced to its one origin `legacy-db`, so the source → origin pair is
 *   the baseline pair: one `pre-existing-touched` CONFLICT, WARN, like P7a. (#49 Stage 1 gave only the
 *   `imports-through-reexport` limitation.)
 * - P8a: The `from` side did not resolve (the import pointed to a missing file) and the `to` side now
 *   resolves to `legacy-db`. Current `next` behavior: `introduced`, BLOCK, because the pair is not in
 *   the baseline.
 * - P8b: The `to` side no longer resolves. Current `next` behavior: no claim, `imports-unresolved`
 *   limitation, PASS.
 * - N1: A change inside the function body that does not touch the import line. Current `next`
 *   behavior: no claim, PASS.
 *
 * Maintenance rule for pinned tests:
 * - Passing tests in this file pin current `next` behavior without altering PASS/WARN/BLOCK/ASK
 *   semantics or exit codes.
 * - A future fix PR (after a new Human Decision that amends H-72 (10) / H-73 (3)) must update the
 *   corresponding pinned assertion to the new expected value and convert the matching `it.todo` in
 *   this file into an active test in the same PR.
 * - Per the #48 direction, reordering, moving, alias-only changes, splitting and merging are not new
 *   violations under any policy, and an unresolved `from` or `to` side must not BLOCK by guess.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService, fileRef, nodeId, type RepoPath } from "@duo-director/core";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureAdoptionBaseline } from "../adoption/baseline.js";
import { violationKey } from "../adoption/key.js";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
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
const IMPORT_LEGACY = 'import { legacyQuery } from "../db/legacy-db.js";\n';

const FILES: Record<string, string> = {
  "package.json": '{ "name": "i48-provenance-fixture", "type": "module" }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "baseUrl": ".", "paths": { "@db/*": ["src/db/*"] } } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: i48-provenance-fixture\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001",
    "title: UI code must not import legacy-db",
    "kind: decision",
    "state: proposed",
    "question: ui_legacy_db_import",
    "answer: UI code must not import src/db/legacy-db.ts",
    "forbids:",
    "  imported_paths: [src/db/legacy-db.ts]",
    "enforcement: block",
    "",
  ].join("\n"),
  "src/db/legacy-db.ts": [
    "export interface LegacyRow { readonly id: string }",
    "export function legacyQuery(sql: string): string {",
    "  return sql;",
    "}",
    "export function legacyCount(sql: string): number {",
    "  return sql.length;",
    "}",
    "",
  ].join("\n"),
  "src/db/index.ts": 'export { legacyQuery, legacyCount } from "./legacy-db.js";\n',
  "src/ui/orders-page.ts": `${IMPORT_LEGACY}\nexport function renderOrders(): string {\n  return legacyQuery("orders");\n}\n`,
  "src/ui/report-page.ts":
    'import { legacyQuery, legacyCount } from "../db/legacy-db.js";\n\nexport function renderReport(): string {\n  return legacyQuery("r") + legacyCount("r");\n}\n',
  "src/ui/stats-page.ts":
    'import { legacyQuery } from "../db/legacy-db.js";\nimport { legacyCount } from "../db/legacy-db.js";\n\nexport function renderStats(): string {\n  return legacyQuery("s") + legacyCount("s");\n}\n',
  "src/ui/row-view.ts":
    'import type { LegacyRow } from "../db/legacy-db.js";\n\nexport function rowId(row: LegacyRow): string {\n  return row.id;\n}\n',
  "src/ui/archive-page.ts":
    'import { legacyQuery } from "../db/legacy-db-v0.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\n',
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-i48-fixture-")));
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

const pairKey = (source: string): string =>
  violationKey("decision-forbids-import", "D-001", `import:${nodeId(fileRef(source as RepoPath))}->${nodeId(fileRef(LEGACY as RepoPath))}`);
const forbiddenImports = (res: ReviewResult): ReviewClaim[] => res.claims.filter((c) => c.rule === "decision-forbids-import");
const importLimits = (res: ReviewResult): string[] => res.limitations.map((l) => l.code).filter((c) => c.startsWith("imports-"));

describe("Issue #48: forbidden-import adoption provenance pinned fixtures (P1–P8, N1)", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, fixture);
    const confirmed = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, "D-001");
    if (confirmed.value === undefined) throw new Error(JSON.stringify(confirmed.diagnostics));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "confirm D-001");
    await repo.index();
    const captured = await withGraph(repo.root, (graph) =>
      captureAdoptionBaseline(repo.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at("2026-09-02T00:00:00.000Z") }),
    );
    if (captured.value === undefined || captured.value.status !== "captured") throw new Error(JSON.stringify(captured));
    // Every UI file that imports legacy-db at HEAD is a baseline pair; archive-page.ts is not (unresolved at HEAD).
    expect(captured.value.baseline.findings.filter((f) => f.rule === "decision-forbids-import").map((f) => f.offending).sort()).toEqual(
      ["src/db/index.ts", "src/ui/orders-page.ts", "src/ui/report-page.ts", "src/ui/row-view.ts", "src/ui/stats-page.ts"]
        .map((p) => `import:${nodeId(fileRef(p as RepoPath))}->${nodeId(fileRef(LEGACY as RepoPath))}`),
    );
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "capture adoption baseline");
  });

  const scenario = async (mutate: (r: ContextRepo) => void): Promise<ReviewResult> => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    mutate(repo);
    const res = await review(repo);
    expect(res.status).toBe("ready");
    return res;
  };

  /** One pre-existing-touched CONFLICT on the source→legacy-db pair key: WARN, not BLOCK (H-72 (10), H-73 (3)). */
  function expectPreExistingTouched(res: ReviewResult, source: string, lines: readonly number[]): void {
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      alignment: "CONFLICT",
      reason: "forbidden-import",
      provenance: "pre-existing-touched",
      blockEligible: false,
      violationKey: pairKey(source),
      subject: { kind: "decision", id: "D-001" },
    });
    for (const line of lines) expect(claims[0]?.observed).toContain(`${source}:${line} import`);
    expect(importLimits(res)).toEqual([]);
    expect(res.verdictBasis.blocking).toEqual([]);
    expect(res.verdict).toBe("WARN");
  }

  it("P1: pins current next behavior (a new name added to an existing import is pre-existing-touched, WARN)", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", "{ legacyQuery }", "{ legacyQuery, legacyCount }"));
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [1]);
  });

  it("P2: pins current next behavior (a second statement importing an already imported name is pre-existing-touched, WARN)", async () => {
    const res = await scenario((r) =>
      r.edit("src/ui/orders-page.ts", IMPORT_LEGACY, `${IMPORT_LEGACY}import { legacyQuery as runLegacy } from "../db/legacy-db.js";\n`),
    );
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [2]);
  });

  it.todo(
    "P1 / P2 follow-up (#48, needs a new Human Decision amending H-72 (10) and H-73 (3)): decide whether a new imported name or a duplicate import inside a baseline pair is a new violation",
  );

  it("P3: pins current next behavior (splitting one import into two statements is pre-existing-touched, WARN; must never BLOCK)", async () => {
    const res = await scenario((r) =>
      r.edit(
        "src/ui/report-page.ts",
        'import { legacyQuery, legacyCount } from "../db/legacy-db.js";\n',
        'import { legacyQuery } from "../db/legacy-db.js";\nimport { legacyCount } from "../db/legacy-db.js";\n',
      ),
    );
    expectPreExistingTouched(res, "src/ui/report-page.ts", [1, 2]);
  });

  it("P4: pins current next behavior (merging two import statements is pre-existing-touched, WARN; must never BLOCK)", async () => {
    const res = await scenario((r) =>
      r.edit(
        "src/ui/stats-page.ts",
        'import { legacyQuery } from "../db/legacy-db.js";\nimport { legacyCount } from "../db/legacy-db.js";\n',
        'import { legacyQuery, legacyCount } from "../db/legacy-db.js";\n',
      ),
    );
    expectPreExistingTouched(res, "src/ui/stats-page.ts", [1]);
  });

  it("P5: pins current next behavior (an alias-only change is pre-existing-touched, WARN; must never BLOCK)", async () => {
    const res = await scenario((r) => {
      r.edit("src/ui/orders-page.ts", "{ legacyQuery }", "{ legacyQuery as query }");
      r.edit("src/ui/orders-page.ts", 'return legacyQuery("orders");', 'return query("orders");');
    });
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [1]);
  });

  it("P6a: pins current next behavior (type-only → value import is pre-existing-touched, WARN)", async () => {
    const res = await scenario((r) => r.edit("src/ui/row-view.ts", "import type { LegacyRow }", "import { LegacyRow }"));
    expectPreExistingTouched(res, "src/ui/row-view.ts", [1]);
  });

  it("P6b: pins current next behavior (value → type-only import is pre-existing-touched, WARN; type-only stays in scope under H-72 (3))", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", "import { legacyQuery }", "import type { legacyQuery }"));
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [1]);
    expect(forbiddenImports(res)[0]?.observed).toContain('import "../db/legacy-db.js" (type-only)');
  });

  it("P7a: pins current next behavior (a tsconfig path alias that resolves to the same file is the same pair: pre-existing-touched, WARN)", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", '"../db/legacy-db.js"', '"@db/legacy-db.js"'));
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [1]);
    expect(forbiddenImports(res)[0]?.observed).toContain('import "@db/legacy-db.js" resolves to src/db/legacy-db.ts');
  });

  it("P7b (#49 Stage 2, H-98): switching the specifier to the re-exporting barrel traces legacyQuery to legacy-db: the baseline pair, pre-existing-touched, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", '"../db/legacy-db.js"', '"../db/index.js"'));
    expectPreExistingTouched(res, "src/ui/orders-page.ts", [1]);
    expect(forbiddenImports(res)[0]?.observed).toContain("re-exports legacyQuery from src/db/legacy-db.ts via src/db/index.ts");
  });

  it("P8a: pins current next behavior (the from side did not resolve and the to side now resolves to legacy-db: introduced, BLOCK)", async () => {
    const res = await scenario((r) => r.edit("src/ui/archive-page.ts", '"../db/legacy-db-v0.js"', '"../db/legacy-db.js"'));
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      alignment: "CONFLICT",
      reason: "forbidden-import",
      provenance: "introduced",
      blockEligible: true,
      violationKey: pairKey("src/ui/archive-page.ts"),
    });
    expect(importLimits(res)).toEqual([]);
    expect(res.verdict).toBe("BLOCK");
  });

  it.todo(
    "P8a follow-up (#48 direction item 5): confirm whether a pair whose from side did not resolve at the baseline must become a limitation instead of BLOCK",
  );

  it("P8b: pins current next behavior (the to side no longer resolves: no claim, imports-unresolved limitation, PASS)", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", '"../db/legacy-db.js"', '"../db/legacy-db-v0.js"'));
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual(["imports-unresolved"]);
    expect(res.limitations.find((l) => l.code === "imports-unresolved")?.message).toContain("src/ui/orders-page.ts:1");
    expect(res.verdict).toBe("PASS");
  });

  it("N1: pins current next behavior (a change that does not touch the import line leaves no claim, PASS)", async () => {
    const res = await scenario((r) => r.edit("src/ui/orders-page.ts", 'legacyQuery("orders")', 'legacyQuery("orders-v2")'));
    expect(forbiddenImports(res)).toEqual([]);
    expect(importLimits(res)).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });
});
