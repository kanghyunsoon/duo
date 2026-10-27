/**
 * Issue #30 ([VAL-03] / Jira S15P31A106-264..267):
 * Minimal reproductions for the 4 known review cases surfaced in the Value Validation
 * detection matrix (#24):
 *
 * 1. L4 (S15P31A106-264 / Follow-up #47): Importer scope contract limit (`forbids.imported_paths`
 *    is repository-wide per H-72 / T40 N3; `governs.paths` does not narrow `forbids`).
 *    0.3.3 contract expects BLOCK; #24 benchmark oracle (R1) marks service-layer import compliant.
 *    Fixed by #47 (Maintainer Decision): D-001 now sets `forbids.importer_paths: [src/ui/**]`, so the
 *    service layer PASSes and the UI layer still BLOCKs.
 * 2. D3 (S15P31A106-265 / Follow-up #48): False negative (WARN instead of BLOCK) when adding a
 *    second forbidden import statement in a file that already had a baseline-recorded `File -> File`
 *    import edge under H-72 pair-level adoption provenance.
 * 3. L1 (S15P31A106-266 / Follow-up #49): Out of current analyzer scope (`scope.duo: "out"` in #24)
 *    on 1-hop barrel re-exports (`src/db/index.ts` re-exports `./legacy-db.js`, UI imports `../db/index.js`).
 * 4. L2 (S15P31A106-267 / Follow-up #50): Out of current analyzer scope (`scope.duo: "out"` in #24)
 *    and missing `imports-unresolved` limitation on computed dynamic imports (`import(\`../db/${name}.js\`)`),
 *    plus newly found L2b static no-substitution template literal (`import(\`../db/legacy-db.js\`)`).
 *
 * Maintenance rule for pinned tests:
 * - Passing tests in this file pin current 0.3.3 behavior (`next` = `v0.3.3` product code) without
 *   altering PASS/WARN/BLOCK/ASK semantics or exit codes.
 * - A future fix PR must update the corresponding pinned assertion to the new expected value,
 *   convert the matching `it.todo` in this file into an active test in the same PR, and update the
 *   status table in `docs/roadmap/0.4.0-issue-30-fp-fn-root-causes.md`.
 * - Any change that alters review verdicts, Decision schema, or Decision Lock digests must link a
 *   recorded Maintainer Decision.
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
import type { ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const human = { kind: "human" as const, name: "Ada" };
const at = (iso: string) => () => new Date(iso);
const W = { from: "HEAD" as const, to: "WORKTREE" as const };
const fileNode = (p: string) => nodeId(fileRef(p as RepoPath));

const FILES: Record<string, string> = {
  "package.json": '{ "name": "val03-fp-fn-fixture", "type": "module" }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true, "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: val03-fp-fn-fixture\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001",
    "title: UI layer must not import legacy-db directly",
    "kind: decision",
    "state: proposed",
    "question: ui_legacy_db_import",
    "answer: UI code (src/ui/**) must not import src/db/legacy-db.ts directly; service layer is allowed",
    "governs:",
    "  paths: [src/ui/**]",
    "forbids:",
    "  imported_paths: [src/db/legacy-db.ts]",
    "  importer_paths: [src/ui/**]",
    "enforcement: block",
    "",
  ].join("\n"),
  "src/db/legacy-db.ts": "export function legacyQuery(sql: string): string {\n  return sql;\n}\n",
  "src/db/index.ts": 'export { legacyQuery } from "./legacy-db.js";\n',
  "src/ui/legacy-orders-page.ts":
    'import { legacyQuery } from "../db/legacy-db.js";\n\nexport function renderOrders(): string {\n  return legacyQuery("SELECT * FROM orders");\n}\n',
  "src/services/order-service.ts": "export function listOrders(): string[] {\n  return [];\n}\n",
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-val03-fixture-")));
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

async function confirm(r: ContextRepo, id: string, when: string): Promise<void> {
  const c = await createDecisionService({ root: r.root, clock: at(when) }).confirm(human, id);
  if (c.value === undefined) throw new Error(JSON.stringify(c.diagnostics));
  r.git("add", "-A");
  r.git("commit", "-q", "-m", `confirm ${id}`);
}

async function captureAndCommitBaseline(r: ContextRepo, when: string): Promise<void> {
  await r.index();
  const c = await withGraph(r.root, (graph) =>
    captureAdoptionBaseline(r.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at(when) }),
  );
  if (c.value === undefined || c.value.status === "aborted") throw new Error(JSON.stringify(c));
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "capture adoption baseline");
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
const importLimits = (res: ReviewResult) =>
  res.limitations.map((l) => l.code).filter((c) => c.startsWith("imports-"));

describe("Issue #30 (VAL-03): pinned 0.3.3 behavior for L4, D3, L1 barrel re-export, and L2 dynamic import", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, fixture);
    await confirm(repo, "D-001", "2026-09-01T00:00:00.000Z");
    await captureAndCommitBaseline(repo, "2026-09-02T00:00:00.000Z");
  });

  const scenario = async (mutate: (r: ContextRepo) => void): Promise<ReviewResult> => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    mutate(repo);
    return review(repo);
  };

  describe("Case L4 (S15P31A106-264 / #47): importer scope (forbids.importer_paths, Maintainer Decision on #47)", () => {
    it("L4 (#47): with importer_paths: [src/ui/**] the service layer importing legacy-db PASSes", async () => {
      // `decisionForbidsImport` (`packages/director/src/review/rules.ts`) skips a Decision whose
      // `forbids.importer_paths` does not match the changed file; `governs.paths` still does not narrow `forbids`.
      const res = await scenario((r) =>
        r.write(
          "src/services/archive.ts",
          'import { legacyQuery } from "../db/legacy-db.js";\n\nexport function archiveOrders(): string {\n  return legacyQuery("DELETE FROM orders");\n}\n',
        ),
      );

      expect(res.verdict).toBe("PASS");
      expect(forbiddenImports(res)).toEqual([]);
      expect(importLimits(res)).toEqual([]);
    });

    it("L4 control (#47): a UI file importing legacy-db is still BLOCKED, and the claim names the importer filter", async () => {
      const res = await scenario((r) =>
        r.write(
          "src/ui/archive-page.ts",
          'import { legacyQuery } from "../db/legacy-db.js";\n\nexport function renderArchive(): string {\n  return legacyQuery("SELECT * FROM archive");\n}\n',
        ),
      );

      expect(res.verdict).toBe("BLOCK");
      const claims = forbiddenImports(res);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        rule: "decision-forbids-import",
        alignment: "CONFLICT",
        reason: "forbidden-import",
        provenance: "introduced",
        blockEligible: true,
        subject: { kind: "decision", id: "D-001" },
        expected: "no changed import in src/ui/** resolves to src/db/legacy-db.ts (D-001)",
      });
    });

    it("L4 baseline (#47): the Adoption Baseline applies the same importer filter as review", () => {
      const dir = path.join(repo.root, ".duo-project/reviews");
      const baselines = fs.readdirSync(dir).filter((f) => f.startsWith("adoption-"));
      expect(baselines).toHaveLength(1);
      const record = JSON.parse(fs.readFileSync(path.join(dir, baselines[0] ?? ""), "utf8")) as { findings: { rule: string; offending: string }[] };
      // src/db/index.ts re-exports legacy-db but is not an importer under src/ui/**, so it is not a baseline pair.
      expect(record.findings.filter((f) => f.rule === "decision-forbids-import").map((f) => f.offending)).toEqual([
        `import:${fileNode("src/ui/legacy-orders-page.ts")}->${fileNode("src/db/legacy-db.ts")}`,
      ]);
    });
  });

  describe("Case D3 (S15P31A106-265 / #48): false negative when adding a second forbidden import statement in a baseline-exempt file", () => {
    it("pins current 0.3.3 behavior (D3): adding a second import to ../db/legacy-db.js in a legacy file yields WARN (pre-existing-touched) instead of BLOCK", async () => {
      // Root cause: `headBaselineFindings` (`packages/director/src/adoption/head.ts`) and `decisionForbidsImport`
      // (`packages/director/src/review/rules.ts`) key findings by the pair-level File->File graph edge
      // (`import:file:src/ui/legacy-orders-page.ts->file:src/db/legacy-db.ts`) per H-72 adoption provenance.
      // A newly added second import statement in `src/ui/legacy-orders-page.ts` produces the exact same
      // `violationKey` with `touched: true`, so `makeClaim` (`packages/director/src/review/claims.ts`)
      // classifies it as `pre-existing-touched` (`blockEligible: false`) and returns WARN instead of BLOCK.
      const res = await scenario((r) =>
        r.write(
          "src/ui/legacy-orders-page.ts",
          [
            'import { legacyQuery } from "../db/legacy-db.js";',
            'import { legacyQuery as legacyCount } from "../db/legacy-db.js";',
            "",
            "export function renderOrders(): string {",
            '  return legacyQuery("SELECT * FROM orders") + legacyCount("SELECT count(*) FROM orders");',
            "}",
            "",
          ].join("\n"),
        ),
      );

      const expectedPairKey = violationKey(
        "decision-forbids-import",
        "D-001",
        `import:${fileNode("src/ui/legacy-orders-page.ts")}->${fileNode("src/db/legacy-db.ts")}`,
      );
      expect(res.verdict).toBe("WARN");
      const claims = forbiddenImports(res);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        rule: "decision-forbids-import",
        alignment: "CONFLICT",
        provenance: "pre-existing-touched",
        blockEligible: false,
        violationKey: expectedPairKey,
      });
    });

    it.todo(
      "0.4 candidate (#48, needs Maintainer Decision): distinguish a newly added import statement from an edited pre-existing import statement in the same source->target file pair",
    );
  });

  describe("Case L1 (S15P31A106-266 / #49): out of current analyzer scope (scope.duo: out in #24) on 1-hop barrel re-export", () => {
    it("pins current 0.3.3 behavior (L1): importing legacyQuery via barrel src/db/index.ts resolves to src/db/index.ts and returns PASS with no limitation", async () => {
      // Root cause: `readIndexedModuleReferences` (`packages/graph/src/incremental/references.ts`) pairs each
      // `entry.analysis.moduleReferences[j]` with its direct 1-hop module resolution (`src/db/index.ts`), and
      // `decisionForbidsImport` (`packages/director/src/review/rules.ts`) only matches `target` against
      // `d.forbids.importedPaths`. Even though `ExportIndex` (`packages/graph/src/build/exports.ts`) follows
      // re-export chains up to `MAX_REEXPORT_DEPTH = 4` for `CALLS` edges, binding-level re-export targets are
      // not stored on module resolutions or checked by `decisionForbidsImport`.
      const res = await scenario((r) =>
        r.write(
          "src/ui/report-page.ts",
          'import { legacyQuery } from "../db/index.js";\n\nexport function renderReport(): string {\n  return legacyQuery("SELECT * FROM reports");\n}\n',
        ),
      );

      expect(res.verdict).toBe("PASS");
      expect(forbiddenImports(res)).toEqual([]);
      expect(importLimits(res)).toEqual([]);
    });

    it.todo(
      "0.4 candidate (#49, needs Maintainer Decision): resolve TS/JS barrel re-export targets (or surface a limitation) when checking forbids.imported_paths",
    );
  });

  describe("Case L2 (S15P31A106-267 / #50): out of current analyzer scope (scope.duo: out in #24) and missing limitation on dynamic import", () => {
    it("pins current 0.3.3 behavior (L2a): computed template-literal dynamic import is dropped by TS/JS extractor (PASS, 0 claims, 0 limitations)", async () => {
      // Root cause: `Extractor.call` (`packages/analyzer/src/language/tree-sitter/ts-js-extract.ts`, lines 656-664)
      // handles `fn.type === "import"` by checking `if (only?.type === "string") this.module(...)` and immediately
      // returning. A template literal `import(\`../db/${name}.js\`)` has `only.type === "template_string"`, so no
      // `ExtractedModuleReference` is emitted and `decisionForbidsImport` never emits `imports-unresolved`.
      const res = await scenario((r) =>
        r.write(
          "src/ui/lazy-page.ts",
          'export async function loadDb(name = "legacy-db"): Promise<unknown> {\n  return import(`../db/${name}.js`);\n}\n',
        ),
      );

      expect(res.verdict).toBe("PASS");
      expect(forbiddenImports(res)).toEqual([]);
      expect(importLimits(res)).toEqual([]);
    });

    it("pins current 0.3.3 behavior (L2b): static no-substitution template literal import(`../db/legacy-db.js`) is dropped because only.type !== 'string'", async () => {
      // Root cause: `literalText(node)` in `ts-js-extract.ts` supports no-substitution `template_string`,
      // but `Extractor.call` gates `this.module(...)` on `only?.type === "string"` instead of `literalText(only) !== undefined`.
      const res = await scenario((r) =>
        r.write(
          "src/ui/lazy-static-template.ts",
          "export async function loadStaticTemplate(): Promise<unknown> {\n  return import(`../db/legacy-db.js`);\n}\n",
        ),
      );

      expect(res.verdict).toBe("PASS");
      expect(forbiddenImports(res)).toEqual([]);
      expect(importLimits(res)).toEqual([]);
    });

    it.todo(
      "0.4 candidate (#50, needs Maintainer Decision if verdict changes): extract no-substitution template literals in import()/require() and emit an unresolved-import limitation for computed dynamic specifiers",
    );
  });
});
