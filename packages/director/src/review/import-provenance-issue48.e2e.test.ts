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
 *   resolves to `legacy-db`. Before H-99: `introduced`, BLOCK, because the pair is not in the baseline.
 *   Since H-99 (#48 P8a): the claim stays, `unverified-at-adoption`, not BLOCK-eligible, with the
 *   `imports-from-side-unresolved` limitation (`path:line`), WARN. Still BLOCK (H-99 (2)): a new import
 *   statement, a from side that resolved to another file (`src/ui/modern-page.ts` → `modern-db`), a new
 *   file, and a specifier change together with a new statement of the same pair. A default import with another
 *   local name (`config-page.ts`) and a side-effect import (`polyfill-page.ts`) are new statements too: the
 *   imported name alone ("default", or none) does not identify the from-side statement. So are a namespace
 *   import with another local name, a bare `export * from`, and a dynamic import. The pairing is one to one: a
 *   second statement next to the replaced or kept one is new, BLOCK. A from side that resolved to a JSON file
 *   (`require("./settings")`) or, through a `.js` specifier, to a `.jsx` file resolved, so it stays BLOCK. The from-side statement must also be gone from the
 *   whole file: no relative reference of any kind, names or spelling may still reach the old module, and the
 *   file may not gain a statement of the same kind and names. One moved below (also through the `@db/*` alias),
 *   kept on its own line after a statement boundary moved, kept as `import type`, merged into another import of
 *   the old module, or respelled (`../db/legacy-db-v0`) is BLOCK. So are `import type` → value import, and a
 *   review whose Adoption Baseline commit is not in the clone (shallow checkout): nothing shows the old specifier
 *   resolved nowhere there. In a partial clone whose baseline blobs cannot be fetched, existence is read from the
 *   tree (#187): a from side that resolved at the baseline is BLOCK, one missing in every tree is still WARN.
 *   Still WARN: two references replaced one by one (same or different missing modules), `import type { X }` →
 *   `import { type X }`, an unrelated barrel import added next to the barrel respecify, and a bare package import
 *   named like the old file. Without an Adoption Baseline, P8a has no provenance and stays
 *   BLOCK.
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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService, fileRef, nodeId, type RepoPath } from "@duo-director/core";
import { indexRepository, openProjectGraphStore, type GraphStore } from "@duo-director/graph";
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
  "src/db/index.ts": 'export { legacyQuery, legacyCount } from "./legacy-db.js";\nexport { legacyQuery as modernQuery } from "./modern-db.js";\n',
  "src/ui/orders-page.ts": `${IMPORT_LEGACY}\nexport function renderOrders(): string {\n  return legacyQuery("orders");\n}\n`,
  "src/ui/report-page.ts":
    'import { legacyQuery, legacyCount } from "../db/legacy-db.js";\n\nexport function renderReport(): string {\n  return legacyQuery("r") + legacyCount("r");\n}\n',
  "src/ui/stats-page.ts":
    'import { legacyQuery } from "../db/legacy-db.js";\nimport { legacyCount } from "../db/legacy-db.js";\n\nexport function renderStats(): string {\n  return legacyQuery("s") + legacyCount("s");\n}\n',
  "src/ui/row-view.ts":
    'import type { LegacyRow } from "../db/legacy-db.js";\n\nexport function rowId(row: LegacyRow): string {\n  return row.id;\n}\n',
  "src/ui/archive-page.ts":
    'import { legacyQuery } from "../db/legacy-db-v0.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\n',
  "src/db/modern-db.ts": "export function legacyQuery(sql: string): string {\n  return sql.trim();\n}\n",
  "src/ui/modern-page.ts":
    'import { legacyQuery } from "../db/modern-db.js";\n\nexport function renderModern(): string {\n  return legacyQuery("m");\n}\n',
  "src/ui/config-page.ts": 'import cfg from "./missing-config.js";\n\nexport const config = cfg;\n',
  "src/ui/polyfill-page.ts": 'import "./old-polyfill.js";\n\nexport const ready = true;\n',
  "src/ui/barrel-ui.ts": 'export * from "./gone-barrel.js";\n',
  "src/ui/ns-page.ts": 'import * as legacy from "./gone-ns.js";\n\nexport const n = legacy;\n',
  "src/ui/lazy-page.ts": 'export const load = () => import("./gone-lazy.js");\n',
  "src/ui/settings.json": '{ "a": 1 }\n',
  "src/ui/cjs-page.ts": 'const cfg = require("./settings");\n\nexport const c = cfg;\n',
  "src/ui/asi-page.ts": 'import { legacyQuery } from "./gone-asi.js"\n;\nexport const a = legacyQuery;\n',
  "src/ui/types-page.ts": 'import type { LegacyRow } from "./gone-types.js";\n\nexport type R = LegacyRow;\n',
  "src/ui/merge-page.ts": 'import { legacyQuery } from "./gone-m.js";\nimport { legacyCount } from "./gone-m.js";\n\nexport const m = [legacyQuery, legacyCount];\n',
  "src/ui/two-page.ts": 'import { legacyQuery as a } from "./gone1.js";\nimport { legacyCount } from "./gone2.js";\n\nexport const t = [a, legacyCount];\n',
  "src/ui/pkg-page.ts": 'import { z } from "zod";\nimport { legacyQuery } from "./zod.js";\n\nexport const p = [z, legacyQuery];\n',
  "src/ui/widget.jsx": 'export const legacyQuery = () => "widget";\n',
  "src/ui/jsx-page.ts": 'import { legacyQuery } from "./widget.js";\n\nexport const w = legacyQuery;\n',
  "src/ui/dup-page.ts": 'import { legacyQuery as a } from "./gone-d.js";\n\nexport const x = a;\n\nimport { legacyQuery as b } from "./gone-d.js";\n\nexport const y = b;\n',
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

  it("P8a (H-99): the from side did not resolve and the to side now resolves to legacy-db: claim kept, not BLOCK-eligible, imports-from-side-unresolved, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/archive-page.ts", '"../db/legacy-db-v0.js"', '"../db/legacy-db.js"'));
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      alignment: "CONFLICT",
      reason: "forbidden-import",
      provenance: "unverified-at-adoption",
      blockEligible: false,
      violationKey: pairKey("src/ui/archive-page.ts"),
    });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.limitations.find((l) => l.code === "imports-from-side-unresolved")?.message).toContain("src/ui/archive-page.ts:1");
    expect(res.verdict).toBe("WARN");
  });

  it("P8a through re-exports (H-99 with H-98): the unresolved from side replaced by the barrel that re-exports legacyQuery is the same case: not BLOCK-eligible, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/archive-page.ts", '"../db/legacy-db-v0.js"', '"../db/index.js"'));
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/archive-page.ts") });
    expect(claims[0]?.observed).toContain("re-exports legacyQuery from src/db/legacy-db.ts via src/db/index.ts");
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.limitations.find((l) => l.code === "imports-from-side-unresolved")?.message).toContain("src/ui/archive-page.ts:1");
    expect(res.verdict).toBe("WARN");
  });

  /** One introduced, BLOCK-eligible claim on `source` → legacy-db and no imports-* limitation (H-99 (2)). */
  const expectIntroduced = (res: ReviewResult, source: string) => {
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ provenance: "introduced", blockEligible: true, violationKey: pairKey(source) });
    expect(importLimits(res)).toEqual([]);
    expect(res.verdict).toBe("BLOCK");
  };

  it("P8a control (H-99 (2)): a new import statement in the file with the unresolved import is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/archive-page.ts", '"../db/legacy-db-v0.js";\n', '"../db/legacy-db-v0.js";\nimport { legacyCount } from "../db/legacy-db.js";\n')), "src/ui/archive-page.ts");
  });

  it("P8a control (H-99 (2)): a from side that resolved to another file (modern-db) and now resolves to legacy-db is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/modern-page.ts", '"../db/modern-db.js"', '"../db/legacy-db.js"')), "src/ui/modern-page.ts");
  });

  it("P8a control (H-99 (2)): a new file importing legacy-db is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.write("src/ui/new-page.ts", 'import { legacyQuery } from "../db/legacy-db.js";\n\nexport const n = legacyQuery("n");\n')), "src/ui/new-page.ts");
  });

  it("P8a control (H-99 (2)): the unresolved specifier replaced together with a new statement of the same pair is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit(
      "src/ui/archive-page.ts",
      'import { legacyQuery } from "../db/legacy-db-v0.js";\n',
      'import { legacyQuery } from "../db/legacy-db.js";\n\nexport { legacyCount } from "../db/legacy-db.js";\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a control (H-99 (2)): a default import with another local name is a new statement, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/config-page.ts", 'import cfg from "./missing-config.js";', 'import db from "../db/legacy-db.js";\nconst cfg = db;')), "src/ui/config-page.ts");
  });

  it("P8a with a default import: the same local name with the unresolved specifier replaced is the same statement, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/config-page.ts", '"./missing-config.js"', '"../db/legacy-db.js"'));
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/config-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a control (H-99 (2)): a side-effect import names nothing, so replacing its unresolved specifier is a new statement, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/polyfill-page.ts", '"./old-polyfill.js"', '"../db/legacy-db.js"')), "src/ui/polyfill-page.ts");
  });

  it("P8a control (H-99 (2)): a bare export * from names nothing, so replacing its unresolved specifier is a new statement, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/barrel-ui.ts", '"./gone-barrel.js"', '"../db/legacy-db.js"')), "src/ui/barrel-ui.ts");
  });

  it("P8a control (H-99 (2)): the unresolved statement kept as it was next to a new statement of the same name is still introduced, BLOCK", async () => {
    const res = await scenario((r) => r.edit(
      "src/ui/archive-page.ts",
      'import { legacyQuery } from "../db/legacy-db-v0.js";\n',
      "import { legacyQuery } from '../db/legacy-db-v0.js';\nimport { legacyQuery as lq } from \"../db/legacy-db.js\";\nexport const q = lq;\n",
    ));
    expect(forbiddenImports(res)).toHaveLength(1);
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "introduced", blockEligible: true, violationKey: pairKey("src/ui/archive-page.ts") });
    expect(importLimits(res)).toEqual(["imports-unresolved"]);
    expect(res.verdict).toBe("BLOCK");
  });

  it("P8a control (H-99 (2)): one unresolved statement replaced by two statements of the same name, one to legacy-db, is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit(
      "src/ui/archive-page.ts",
      'import { legacyQuery } from "../db/legacy-db-v0.js";\n',
      'import { legacyQuery } from "../db/modern-db.js";\nimport { legacyQuery as lq } from "../db/legacy-db.js";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a with a namespace import: the same local name with the unresolved specifier replaced is the same statement, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/ns-page.ts", '"./gone-ns.js"', '"../db/legacy-db.js"'));
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/ns-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a control (H-99 (2)): a namespace import with another local name is a new statement, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/ns-page.ts", 'import * as legacy from "./gone-ns.js";', 'import * as db from "../db/legacy-db.js";\nconst legacy = db;')), "src/ui/ns-page.ts");
  });

  it("P8a control (H-99 (2)): a dynamic import names nothing, so replacing its unresolved specifier is a new statement, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/lazy-page.ts", '"./gone-lazy.js"', '"../db/legacy-db.js"')), "src/ui/lazy-page.ts");
  });

  it("P8a control (H-99 (2)): a from side that resolved to a JSON file (require(\"./settings\") → settings.json) is still introduced, BLOCK", async () => {
    expectIntroduced(await scenario((r) => r.edit("src/ui/cjs-page.ts", '"./settings"', '"../db/legacy-db.js"')), "src/ui/cjs-page.ts");
  });

  /** BLOCK, no H-99 limitation; other imports-* limitations (the kept unresolved import) may remain. */
  const expectBlocked = (res: ReviewResult, source: string) => {
    expect(forbiddenImports(res)).toHaveLength(1);
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "introduced", blockEligible: true, violationKey: pairKey(source) });
    expect(importLimits(res)).not.toContain("imports-from-side-unresolved");
    expect(res.verdict).toBe("BLOCK");
  };

  it("P8a control (H-99 (2)): the unresolved statement moved below and a new statement in its place is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.write(
      "src/ui/archive-page.ts",
      'import { legacyQuery as lq } from "../db/legacy-db.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\nimport { legacyQuery } from "../db/legacy-db-v0.js";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a control (H-99 (2), Amendment path): the same move with the new statement through the barrel is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.write(
      "src/ui/archive-page.ts",
      'import { legacyQuery as lq } from "../db/index.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\nimport { legacyQuery } from "../db/legacy-db-v0.js";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a control (H-99 (2)): the unresolved statement kept after its own-line semicolon becomes a new statement is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.write(
      "src/ui/asi-page.ts",
      'import { legacyQuery } from "./gone-asi.js"\nimport { legacyQuery as lq } from "../db/legacy-db.js";\nexport const a = legacyQuery;\n',
    )), "src/ui/asi-page.ts");
  });

  it("P8a control (H-99 (2)): import type replaced by a value import is not the same statement, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.edit("src/ui/types-page.ts", 'import type { LegacyRow } from "./gone-types.js";', 'import { LegacyRow } from "../db/legacy-db.js";')), "src/ui/types-page.ts");
  });

  it("P8a control (H-99 (2)): the unresolved statement kept as import type next to a new value import is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.edit(
      "src/ui/archive-page.ts",
      'import { legacyQuery } from "../db/legacy-db-v0.js";\n',
      'import type { legacyQuery } from "../db/legacy-db-v0.js";\nimport { legacyQuery as lq } from "../db/legacy-db.js";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a control (H-99 (2)): the unresolved statement merged into another import of the same missing module is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.edit(
      "src/ui/merge-page.ts",
      'import { legacyQuery } from "./gone-m.js";\nimport { legacyCount } from "./gone-m.js";\n',
      'import { legacyQuery as lq } from "../db/legacy-db.js";\nimport { legacyCount, legacyQuery } from "./gone-m.js";\nexport const q = lq;\n',
    )), "src/ui/merge-page.ts");
  });

  it("P8a control (H-99 (2)): the unresolved statement moved below with another spelling of the same module is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.write(
      "src/ui/archive-page.ts",
      'import { legacyQuery as lq } from "../db/legacy-db.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\nimport { legacyQuery } from "../db/legacy-db-v0";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a with two aliased imports of the same missing module, each replaced: both lines are the same statements, WARN", async () => {
    const res = await scenario((r) => {
      r.edit("src/ui/dup-page.ts", 'import { legacyQuery as a } from "./gone-d.js";', 'import { legacyQuery as a } from "../db/legacy-db.js";');
      r.edit("src/ui/dup-page.ts", 'import { legacyQuery as b } from "./gone-d.js";', 'import { legacyQuery as b } from "../db/legacy-db.js";');
    });
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/dup-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a with import type { X } respelled as import { type X }: the same statement, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/types-page.ts", 'import type { LegacyRow } from "./gone-types.js";', 'import { type LegacyRow } from "../db/legacy-db.js";'));
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/types-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a control (H-99 (2)): the unresolved statement moved below through a tsconfig path alias is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.write(
      "src/ui/archive-page.ts",
      'import { legacyQuery as lq } from "../db/legacy-db.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("a");\n}\nimport { legacyQuery } from "@db/legacy-db-v0.js";\nexport const q = lq;\n',
    )), "src/ui/archive-page.ts");
  });

  it("P8a with two different missing modules, each replaced by the same forbidden specifier: both are the same statements, WARN", async () => {
    const res = await scenario((r) => {
      r.edit("src/ui/two-page.ts", '"./gone1.js"', '"../db/legacy-db.js"');
      r.edit("src/ui/two-page.ts", '"./gone2.js"', '"../db/legacy-db.js"');
    });
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/two-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a through re-exports with an added barrel import whose origin is allowed (modern-db): still the same statement, WARN", async () => {
    const res = await scenario((r) => r.edit(
      "src/ui/archive-page.ts",
      'import { legacyQuery } from "../db/legacy-db-v0.js";\n',
      'import { legacyQuery } from "../db/index.js";\nimport { modernQuery } from "../db/index.js";\nexport const m = modernQuery;\n',
    ));
    expect(forbiddenImports(res)).toHaveLength(1);
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/archive-page.ts") });
    expect(importLimits(res)).toEqual(["imports-from-side-unresolved"]);
    expect(res.verdict).toBe("WARN");
  });

  it("P8a next to a bare package import named like the old file (zod vs ./zod.js): the package is not the old module, WARN", async () => {
    const res = await scenario((r) => r.edit("src/ui/pkg-page.ts", '"./zod.js"', '"../db/legacy-db.js"'));
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/pkg-page.ts") });
    expect(importLimits(res)).toContain("imports-from-side-unresolved");
    expect(res.verdict).toBe("WARN");
  });

  it("P8a control (H-99 (2)): a from side whose .js specifier named an existing .jsx file resolved, so it is still introduced, BLOCK", async () => {
    expectBlocked(await scenario((r) => r.edit("src/ui/jsx-page.ts", '"./widget.js"', '"../db/legacy-db.js"')), "src/ui/jsx-page.ts");
  });

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

describe("Issue #48 P8a without an Adoption Baseline", () => {
  it("P8a control: with no baseline there is no provenance, so the replaced unresolved specifier stays BLOCK without imports-from-side-unresolved", async () => {
    const repo = makeContextRepo(temps, registry, fixture);
    const confirmed = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, "D-001");
    if (confirmed.value === undefined) throw new Error(JSON.stringify(confirmed.diagnostics));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "confirm D-001");
    repo.edit("src/ui/archive-page.ts", '"../db/legacy-db-v0.js"', '"../db/legacy-db.js"');
    const res = await review(repo);
    expect(res.baseline.status).toBe("missing");
    const claims = forbiddenImports(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ alignment: "CONFLICT", blockEligible: true, violationKey: pairKey("src/ui/archive-page.ts") });
    expect(claims[0]?.provenance).toBeUndefined();
    expect(importLimits(res)).toEqual([]);
    expect(res.verdict).toBe("BLOCK");
  });
});

/**
 * A repository whose Adoption Baseline was captured while src/db/modern-db.ts existed, then modern-db.ts was deleted:
 * modern-page's import resolved at the baseline but not at the diff base.
 */
async function baselineThenDropModernDb(): Promise<{ readonly repo: ContextRepo; readonly baselineCommit: string }> {
  const repo = makeContextRepo(temps, registry, fixture);
  const confirmed = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, "D-001");
  if (confirmed.value === undefined) throw new Error(JSON.stringify(confirmed.diagnostics));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "confirm D-001");
  await repo.index();
  const captured = await withGraph(repo.root, (graph) =>
    captureAdoptionBaseline(repo.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at("2026-09-02T00:00:00.000Z") }),
  );
  if (captured.value === undefined || captured.value.status !== "captured") throw new Error(JSON.stringify(captured));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "capture adoption baseline");
  repo.git("rm", "-q", "src/db/modern-db.ts");
  repo.git("commit", "-q", "-m", "drop modern-db");
  return { repo, baselineCommit: captured.value.baseline.git.headOid };
}

function cloneOf(source: string, args: readonly string[]): string {
  const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-i48-clone-")));
  temps.push(clone);
  fs.rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", ...args, `file://${source.replace(/\\/g, "/")}`, clone], { windowsHide: true });
  return clone;
}

/** Index and review the working tree of `root` (a clone, not a ContextRepo). */
async function reviewAt(root: string): Promise<ReviewResult> {
  await withGraph(root, async (store) => {
    const indexed = await indexRepository(root, { store, registry, historyWindow: HISTORY });
    if (indexed.value === undefined) throw new Error(JSON.stringify(indexed.diagnostics));
  });
  return withGraph(root, async (graph) => {
    const out = await reviewChanges(root, { diff: W }, { graph, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  });
}

const replaceIn = (root: string, file: string, from: string, to: string) => {
  const abs = path.join(root, file);
  fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(from, to));
};

describe("Issue #48 P8a when the Adoption Baseline cannot be read in full", () => {
  it("P8a control (H-99 (1), (3)): a from side that resolved at the baseline stays BLOCK in a shallow clone that lacks the baseline commit", async () => {
    const { repo, baselineCommit } = await baselineThenDropModernDb();
    const clone = cloneOf(repo.root, ["--depth", "1"]);
    expect(() => execFileSync("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], { cwd: clone, stdio: "ignore", windowsHide: true })).toThrow();
    replaceIn(clone, "src/ui/modern-page.ts", '"../db/modern-db.js"', '"../db/legacy-db.js"');
    const res = await reviewAt(clone);
    expect(forbiddenImports(res)[0]).toMatchObject({ provenance: "introduced", blockEligible: true, violationKey: pairKey("src/ui/modern-page.ts") });
    expect(importLimits(res)).not.toContain("imports-from-side-unresolved");
    expect(res.verdict).toBe("BLOCK");
  });

  it("#187: in a partial clone whose baseline blobs cannot be fetched, a from side that resolved at the baseline stays BLOCK; a missing one stays WARN", async () => {
    const { repo, baselineCommit } = await baselineThenDropModernDb();
    // Full clone control: the baseline blob is local, so the from side resolved there and the claim is introduced.
    replaceIn(repo.root, "src/ui/modern-page.ts", '"../db/modern-db.js"', '"../db/legacy-db.js"');
    const full = await review(repo);
    expect(forbiddenImports(full)[0]).toMatchObject({ provenance: "introduced", blockEligible: true });
    expect(full.verdict).toBe("BLOCK");
    repo.git("checkout", "--", "src/ui/modern-page.ts");

    repo.git("config", "uploadpack.allowFilter", "true");
    const clone = cloneOf(repo.root, ["--filter=blob:none"]);
    // The lazy fetch of a missing blob must fail: point origin at a path that does not exist.
    const gone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-i48-gone-")));
    temps.push(gone);
    execFileSync("git", ["remote", "set-url", "origin", path.join(gone, "missing.git")], { cwd: clone, windowsHide: true });
    // modern-db.ts exists in the baseline tree, but its blob is not in the clone and cannot be fetched.
    expect(execFileSync("git", ["ls-tree", "--name-only", baselineCommit, "--", "src/db/modern-db.ts"], { cwd: clone, encoding: "utf8", windowsHide: true }).trim()).toBe("src/db/modern-db.ts");
    expect(() => execFileSync("git", ["cat-file", "blob", `${baselineCommit}:src/db/modern-db.ts`], { cwd: clone, stdio: "ignore", windowsHide: true })).toThrow();

    replaceIn(clone, "src/ui/modern-page.ts", '"../db/modern-db.js"', '"../db/legacy-db.js"');
    const partial = await reviewAt(clone);
    expect(forbiddenImports(partial)[0]).toMatchObject({ provenance: "introduced", blockEligible: true, violationKey: pairKey("src/ui/modern-page.ts") });
    expect(importLimits(partial)).not.toContain("imports-from-side-unresolved");
    expect(partial.verdict).toBe("BLOCK");

    // A from side that is missing in every tree is still the H-99 case in the same partial clone: WARN.
    execFileSync("git", ["checkout", "--", "src/ui/modern-page.ts"], { cwd: clone, windowsHide: true });
    replaceIn(clone, "src/ui/archive-page.ts", '"../db/legacy-db-v0.js"', '"../db/legacy-db.js"');
    const missing = await reviewAt(clone);
    expect(forbiddenImports(missing)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false, violationKey: pairKey("src/ui/archive-page.ts") });
    expect(importLimits(missing)).toEqual(["imports-from-side-unresolved"]);
    expect(missing.verdict).toBe("WARN");
  });
});
