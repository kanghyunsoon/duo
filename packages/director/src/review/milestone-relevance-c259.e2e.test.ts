/**
 * Issue #59 ([C259] Milestone relevance: WARN on normal edits to files of another milestone's
 * Requirement — part of #5 / Jira S15P31A106-258).
 *
 * Fixture: two milestones (M1 done, M2 active), `current_milestone: M2`. REQ-001 and REQ-003 belong
 * to M1, REQ-002 to M2. Each Requirement is implemented by an annotated source file (IMPLEMENTS) and
 * validated by an annotated test (VALIDATED_BY), so `test-coverage` is ALIGNED in every case and the
 * only WARN basis left is `requirement-implementation` (`rules.ts` `requirementImplementation`).
 *
 * Fixtures (F1–F4, N1–N2) and H-100 (Maintainer Decision on #59, option 2: information only):
 * - F1: Ordinary edit to `src/a.ts` (implements REQ-001, milestone M1). Before H-100:
 *       `outside-current-milestone`, PARTIAL, WARN (the C259 pattern from the T61/T69 audits). Since H-100:
 *       one claim for the file, still `outside-current-milestone` with the fact in `observed`, but
 *       `informational`, so it is not a WARN basis: PASS.
 * - F2: Same edit, with a natural-language task whose context contains `src/a.ts`: `in-task-context`
 *       (ALIGNED) and, since H-100, PASS.
 * - F3: Edit to `src/name.ts`, which implements two M1 Requirements (REQ-001, REQ-003). Before H-100: one
 *       PARTIAL claim per Requirement (the multiplier behind up to 17 claims in one commit in T61). Since
 *       H-100: one informational claim for the file that names both Requirements, PASS.
 * - F4: Edit to `src/a.ts` together with its validating test `test/a.test.ts`: the same as F1, PASS
 *       (#59 policy option 3, "warn when tests change", is not adopted, H-100 (5)).
 * - F1 + an unrelated file outside the task: the informational claim is no basis, the independent
 *       `outside-task-context` drift of the other file still warns (H-100 (4)).
 * - N1: Ordinary edit to `src/b.ts` (implements REQ-002, milestone M2 = current): `meaning-not-decidable`
 *       (plain UNKNOWN), PASS.
 * - N2: The F1 edit with no `current_milestone` in `project.yaml`: `meaning-not-decidable`, PASS.
 *
 * Maintenance rule for pinned tests:
 * - Passing tests in this file pin current `next` behavior without altering PASS/WARN/BLOCK/ASK
 *   semantics or exit codes.
 * - A future fix PR (after the policy is agreed in #5 and recorded as a Maintainer Decision) must
 *   update the corresponding pinned assertion to the new expected value and convert the matching
 *   `it.todo` in this file into an active test in the same PR.
 * - Whatever the policy, the fact that a change implements another milestone's Requirement must stay
 *   visible (#5 non-goal: no hidden facts); F1 pins that fact in the claim's `observed` text and F3 keeps
 *   every Requirement ID and its evidence in one claim.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewClaim, ReviewRequest, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const W = { from: "HEAD" as const, to: "WORKTREE" as const };

const TASK_F2 = "Change the CSV export separator";

const PROJECT_YAML = "schema_version: 1\nname: c259-milestone-fixture\ncurrent_milestone: M2\n";
const PROJECT_YAML_NO_CURRENT = "schema_version: 1\nname: c259-milestone-fixture\n";

const FILES: Record<string, string> = {
  "package.json": '{ "name": "c259-milestone-fixture", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": PROJECT_YAML,
  ".duo-project/milestones/M1.yaml": "id: M1\ntitle: Export\nstate: done\n",
  ".duo-project/milestones/M2.yaml": "id: M2\ntitle: Import\nstate: active\n",
  ".duo-project/specs/product.md": [
    "# Product", "",
    "## REQ-001 Export a report as CSV", "", "```duo", "status: done", "milestone: M1", "priority: must", "```", "",
    "Export the report rows as CSV with a header line.", "",
    "## REQ-002 Import a report from CSV", "", "```duo", "status: planned", "milestone: M2", "priority: must", "```", "",
    "Read report rows from a CSV file with a header line.", "",
    "## REQ-003 Name exported files by date", "", "```duo", "status: done", "milestone: M1", "priority: should", "```", "",
    "Exported files are named by the report date.", "",
  ].join("\n"),
  "src/a.ts": [
    "// duo: REQ-001",
    "export function exportCsv(rows: readonly string[][]): string {",
    '  return rows.map((r) => r.join(",")).join("\\n");',
    "}",
    "",
  ].join("\n"),
  "src/b.ts": [
    "// duo: REQ-002",
    "export function importCsv(text: string): string[][] {",
    '  return text.split("\\n").map((l) => l.split(","));',
    "}",
    "",
  ].join("\n"),
  "src/name.ts": [
    "// duo: REQ-001, REQ-003",
    "export function exportName(date: string): string {",
    "  return `report-${date}.csv`;",
    "}",
    "",
  ].join("\n"),
  "test/a.test.ts": [
    'import { exportCsv } from "../src/a.js";',
    "",
    "// duo: REQ-001",
    'it("exports rows as CSV", () => {',
    '  if (exportCsv([["a", "b"]]) !== "a,b") throw new Error("export");',
    "});",
    "",
  ].join("\n"),
  "test/b.test.ts": [
    'import { importCsv } from "../src/b.js";',
    "",
    "// duo: REQ-002",
    'it("imports rows from CSV", () => {',
    '  if (importCsv("a,b")[0]?.[1] !== "b") throw new Error("import");',
    "});",
    "",
  ].join("\n"),
  "test/name.test.ts": [
    'import { exportName } from "../src/name.js";',
    "",
    "// duo: REQ-001, REQ-003",
    'it("names exported files by date", () => {',
    '  if (exportName("2026-01-01") !== "report-2026-01-01.csv") throw new Error("name");',
    "});",
    "",
  ].join("\n"),
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-c259-fixture-")));
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

async function runReview(r: ContextRepo, request: ReviewRequest): Promise<ReviewResult> {
  await r.index();
  return withGraph(r.root, async (graph) => {
    const out = await reviewChanges(r.root, request, { graph, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  });
}

const ruleClaims = (res: ReviewResult, rule: string): ReviewClaim[] => res.claims.filter((c) => c.rule === rule);

const EDIT_A: readonly [string, string, string] = ["src/a.ts", 'r.join(",")', 'r.join(";")'];

describe("Issue #59 ([C259]): milestone relevance pinned fixtures (F1–F4, N1–N2)", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, fixture);
    await repo.index();
  });

  function reset(): void {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
  }

  /** Every test-coverage claim is ALIGNED, so requirement-implementation is the only possible WARN basis. */
  function expectTestsCovered(res: ReviewResult, requirements: readonly string[]): void {
    expect(ruleClaims(res, "test-coverage").map((c) => `${c.subject.id} ${c.alignment} ${c.reason}`).sort()).toEqual(
      requirements.map((id) => `${id} ALIGNED related-test-exists`).sort(),
    );
  }

  /** The single informational claim for `file`, and no WARN basis from it. */
  function expectInformation(res: ReviewResult, file: string, observed: string): ReviewClaim {
    const claims = ruleClaims(res, "requirement-implementation");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      rule: "requirement-implementation",
      subject: { kind: "file", id: file },
      alignment: "PARTIAL",
      reason: "outside-current-milestone",
      informational: true,
      drift: false,
      blockEligible: false,
      // The underlying fact stays visible (#5 non-goal: no hidden facts).
      expected: "changes serve the current milestone M2",
      observed,
    });
    expect(res.verdictBasis.warn).not.toContain(claims[0]?.id);
    return claims[0] as ReviewClaim;
  }

  it("F1 (H-100): an ordinary edit to a file implementing an M1 Requirement while M2 is current is an informational outside-current-milestone claim, PASS", async () => {
    reset();
    repo.edit(...EDIT_A);

    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual(["src/a.ts#exportCsv hunk-overlap"]);
    expectTestsCovered(res, ["REQ-001"]);
    expectInformation(res, "src/a.ts", "src/a.ts#exportCsv implement REQ-001 (milestone M1)");
    expect(res.verdictBasis).toEqual({ blocking: [], ask: [], warn: [] });
    expect(res.verdict).toBe("PASS");
  });

  it("F2 (H-100): with a task whose context contains src/a.ts the edit is in-task-context and PASS", async () => {
    reset();
    repo.edit(...EDIT_A);

    const res = await runReview(repo, { task: TASK_F2, diff: W });
    expect(res.status).toBe("ready");
    expect(ruleClaims(res, "scope-relevance")).toEqual([
      expect.objectContaining({
        subject: { kind: "file", id: "src/a.ts" },
        alignment: "ALIGNED",
        reason: "in-task-context",
        drift: false,
      }),
    ]);
    expectTestsCovered(res, ["REQ-001"]);
    expectInformation(res, "src/a.ts", "src/a.ts#exportCsv implement REQ-001 (milestone M1)");
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it("F3 (H-100): one changed function implementing two M1 Requirements is one informational claim for the file that keeps both Requirements and their evidence, PASS", async () => {
    reset();
    repo.edit("src/name.ts", "  return `report-${date}.csv`;", "  return `report-${date.trim()}.csv`;");

    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual(["src/name.ts#exportName hunk-overlap"]);
    expectTestsCovered(res, ["REQ-001", "REQ-003"]);
    const c = expectInformation(res, "src/name.ts", "src/name.ts#exportName implement REQ-001 (milestone M1), REQ-003 (milestone M1)");
    // Both Requirements are cited as evidence.
    const cited = c.evidenceIds.map((id) => res.evidence.find((e) => e.id === id)).filter((e) => e?.entity?.type === "requirement").map((e) => (e?.entity as { id: string }).id);
    expect(cited.sort()).toEqual(["REQ-001", "REQ-003"]);
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it("F4 (H-100): editing the M1 code together with its validating test is the same as F1 (option 3 not adopted), PASS", async () => {
    reset();
    repo.edit(...EDIT_A);
    repo.edit("test/a.test.ts", 'it("exports rows as CSV"', 'it("exports rows as CSV text"');

    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`).sort()).toEqual([
      "src/a.ts#exportCsv hunk-overlap",
      "test/a.test.ts#exports rows as CSV text hunk-overlap",
    ]);
    expectTestsCovered(res, ["REQ-001"]);
    expectInformation(res, "src/a.ts", "src/a.ts#exportCsv implement REQ-001 (milestone M1)");
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it("H-100 (4): with F1 and an unrelated file outside the task, the independent outside-task-context drift still warns", async () => {
    reset();
    repo.edit(...EDIT_A);
    repo.write("src/unrelated.ts", "export function unrelated(): number {\n  return 1;\n}\n");

    const res = await runReview(repo, { task: TASK_F2, diff: W });
    expect(res.status).toBe("ready");
    const info = expectInformation(res, "src/a.ts", "src/a.ts#exportCsv implement REQ-001 (milestone M1)");
    const drift = res.claims.filter((c) => c.drift && c.subject.id === "src/unrelated.ts");
    expect(drift.map((c) => `${c.rule} ${c.reason}`)).toEqual([expect.stringMatching(/^(scope-relevance outside-task-context|unlinked-addition added-file-unlinked)$/u)]);
    expect(res.verdictBasis.warn).toEqual(drift.map((c) => c.id));
    expect(res.verdictBasis.warn).not.toContain(info.id);
    expect(res.verdict).toBe("WARN");
  });

  it("N1: pins current next behavior (edit to a file implementing a Requirement of the current milestone M2 is meaning-not-decidable, PASS; must stay non-WARN)", async () => {
    reset();
    repo.edit("src/b.ts", "l.split(\",\")", "l.split(\";\")");

    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual(["src/b.ts#importCsv hunk-overlap"]);
    expectTestsCovered(res, ["REQ-002"]);
    expect(ruleClaims(res, "requirement-implementation")).toEqual([
      expect.objectContaining({
        subject: { kind: "requirement", id: "REQ-002" },
        alignment: "UNKNOWN",
        reason: "meaning-not-decidable",
        drift: false,
      }),
    ]);
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it("N2: pins current next behavior (the F1 edit with no current_milestone is meaning-not-decidable, PASS)", async () => {
    reset();
    repo.write(".duo-project/project.yaml", PROJECT_YAML_NO_CURRENT);
    repo.git("commit", "-qam", "unset current_milestone");
    try {
      repo.edit(...EDIT_A);
      const res = await runReview(repo, { diff: W });
      expect(res.status).toBe("ready");
      expectTestsCovered(res, ["REQ-001"]);
      expect(ruleClaims(res, "requirement-implementation")).toEqual([
        expect.objectContaining({
          subject: { kind: "requirement", id: "REQ-001" },
          alignment: "UNKNOWN",
          reason: "meaning-not-decidable",
          drift: false,
        }),
      ]);
      expect(res.verdictBasis.warn).toEqual([]);
      expect(res.verdict).toBe("PASS");
    } finally {
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });
});
