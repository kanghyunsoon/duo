/**
 * Issue #166, H-105: a change inside a TypeScript/JavaScript symbol also counts the IMPLEMENTS and GOVERNS links of the
 * file that contains the symbol (its owner file, the graph's file → symbol CONTAINS edge). Before H-105 a Requirement
 * linked only through implements.paths, and a Decision governing only through governs.paths, disappeared from review
 * when the hunk was inside a symbol, while the same change as a file seed (control C) reported them.
 *
 * Fixture (current milestone M1):
 * - SCORE-01 (M1): implements.paths src/**. D-001: governs.paths src/**, no forbids. src/score.ts has a function and a
 *   class method. No test validates SCORE-01.
 * - BOTH-01 (M1): implements.symbols [rank] and implements.paths rank/**: one Requirement through both links.
 * - SYM-01 (M1): implements.symbols [formatName] only: the existing symbol-linked result.
 * - OTHER-01 (M1): implements.paths lib/**: never pulled into a change elsewhere.
 * - OLD-01 (M2, not current): implements.paths legacy/**: H-100 keeps it an informational claim.
 * - D-002: forbids.paths blocked/**, enforcement block: a body change there still BLOCKs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewClaim, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;

const requirement = (id: string, title: string, milestone: string, implementsLines: readonly string[]) => [
  `## ${id} ${title}`, "", "```duo", "status: in_progress", `milestone: ${milestone}`, "priority: must", "implements:", ...implementsLines, "```", "",
  `${title}.`, "",
];
const decision = (id: string, lines: readonly string[]) => [
  `id: ${id}`, `title: ${id} decision`, "kind: decision", "state: confirmed", `question: ${id.toLowerCase()}`, "answer: as stated", "owner: human",
  ...lines, 'confirmed_at: "2026-11-01T00:00:00Z"', "confirmed_by: tester", "",
].join("\n");

const FILES: Record<string, string> = {
  "package.json": '{ "name": "owner-file-links", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: owner-file-links\ncurrent_milestone: M1\n",
  ".duo-project/milestones/M1.yaml": "id: M1\ntitle: Scoring\nstate: active\n",
  ".duo-project/milestones/M2.yaml": "id: M2\ntitle: Legacy\nstate: done\n",
  ".duo-project/specs/scoring.md": [
    "# Scoring", "",
    ...requirement("SCORE-01", "Score a round", "M1", ['  paths: ["src/**"]']),
    ...requirement("BOTH-01", "Rank players", "M1", ['  paths: ["rank/**"]', "  symbols: [rank]"]),
    ...requirement("SYM-01", "Format player names", "M1", ["  symbols: [formatName]"]),
    ...requirement("OTHER-01", "Keep other helpers", "M1", ['  paths: ["lib/**"]']),
    ...requirement("OLD-01", "Legacy scoring", "M2", ['  paths: ["legacy/**"]']),
  ].join("\n"),
  ".duo-project/decisions/D-001.yaml": decision("D-001", ["governs:", '  paths: ["src/**"]']),
  ".duo-project/decisions/D-002.yaml": decision("D-002", ["forbids:", '  paths: ["blocked/**"]', "enforcement: block"]),
  "src/score.ts": [
    "export function score(n: number): number {", "  return n + 1;", "}", "",
    "export class Board {", "  add(n: number): number {", "    return n * 2;", "  }", "}", "",
  ].join("\n"),
  "rank/rank.ts": "export function rank(points: number): number {\n  return points > 10 ? 1 : 2;\n}\n",
  "sym/name.ts": "export function formatName(name: string): string {\n  return name.trim();\n}\n",
  "lib/other.ts": "export function other(): string {\n  return \"other\";\n}\n",
  "legacy/old.ts": "export function oldScore(n: number): number {\n  return n;\n}\n",
  "blocked/legacy.ts": "export function legacy(): number {\n  return 1;\n}\n",
};

const results = new Map<string, ReviewResult>();

async function review(): Promise<ReviewResult> {
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(repo.root, { diff: { from: "HEAD", to: "WORKTREE" } }, { graph: opened.value, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  } finally {
    opened.value.close();
  }
}

const SCENARIOS: Record<string, () => void> = {
  A: () => repo.edit("src/score.ts", "return n + 1;", "return n + 2;"),
  "A-method": () => repo.edit("src/score.ts", "return n * 2;", "return n * 3;"),
  C: () => repo.write("src/data.json", '{ "rounds": 3 }\n'),
  BOTH: () => repo.edit("rank/rank.ts", "points > 10", "points > 20"),
  SYM: () => repo.edit("sym/name.ts", "name.trim()", "name.trim().toLowerCase()"),
  OLD: () => repo.edit("legacy/old.ts", "return n;", "return n + 0;"),
  FORBID: () => repo.edit("blocked/legacy.ts", "return 1;", "return 2;"),
};

beforeAll(async () => {
  registry = await contextRegistry();
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-owner-links-")));
  temps.push(fixture);
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true });
    fs.writeFileSync(path.join(fixture, f), text);
  }
  repo = makeContextRepo(temps, registry, fixture);
  for (const [name, mutate] of Object.entries(SCENARIOS)) {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    mutate();
    await repo.index();
    results.set(name, await review());
  }
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const result = (name: string): ReviewResult => {
  const r = results.get(name);
  if (r === undefined) throw new Error(`no result for ${name}`);
  return r;
};
const claims = (r: ReviewResult, rule: string): ReviewClaim[] => r.claims.filter((c) => c.rule === rule);
const subjects = (r: ReviewResult, rule: string): string[] => claims(r, rule).map((c) => `${c.subject.id} ${c.alignment} ${c.reason}`).sort();
const seeds = (r: ReviewResult): string[] => r.seeds.map((s) => `${s.ref} ${s.reason}`);

describe("Issue #166 (H-105): a symbol change follows its owner file's IMPLEMENTS and GOVERNS links", () => {
  it("A: a body change inside a function reports the implements.paths Requirement (SCORE-01) through the owner file", () => {
    const r = result("A");
    expect(seeds(r)).toEqual(["src/score.ts#score hunk-overlap"]);
    expect(subjects(r, "requirement-implementation")).toEqual(["SCORE-01 UNKNOWN meaning-not-decidable"]);
    expect(claims(r, "requirement-implementation")[0]?.observed).toContain("src/score.ts#score implement SCORE-01");
  });

  it("B: the same change reports the governs.paths-only Decision D-001 through the owner file", () => {
    expect(subjects(result("A"), "decision-governance")).toEqual(["D-001 ALIGNED governed-no-forbidden-change"]);
  });

  it("A, nested symbol: a class method body change reaches the same owner-file links", () => {
    const r = result("A-method");
    expect(seeds(r)).toEqual(["src/score.ts#Board.add hunk-overlap"]);
    expect(subjects(r, "requirement-implementation")).toEqual(["SCORE-01 UNKNOWN meaning-not-decidable"]);
    expect(subjects(r, "decision-governance")).toEqual(["D-001 ALIGNED governed-no-forbidden-change"]);
  });

  it("control C: adding src/data.json (a file seed) reports the same Requirement and Decision as before", () => {
    const c = result("C");
    expect(seeds(c)).toEqual(["src/data.json file-changed"]);
    expect(subjects(c, "requirement-implementation")).toEqual(["SCORE-01 UNKNOWN meaning-not-decidable"]);
    expect(subjects(c, "test-coverage")).toEqual(["SCORE-01 UNKNOWN tests-not-analyzable"]);
    expect(subjects(c, "decision-governance")).toEqual(["D-001 ALIGNED governed-no-forbidden-change"]);
    // Case A now reports the same Requirement and Decision as the file seed.
    const ids = (r: ReviewResult, rule: string) => claims(r, rule).map((x) => x.subject.id);
    expect(ids(result("A"), "requirement-implementation")).toEqual(ids(c, "requirement-implementation"));
    expect(ids(result("A"), "decision-governance")).toEqual(ids(c, "decision-governance"));
  });

  it("C: a Requirement linked by both implements.symbols and implements.paths is reported once", () => {
    const r = result("BOTH");
    expect(seeds(r)).toEqual(["rank/rank.ts#rank hunk-overlap"]);
    expect(subjects(r, "requirement-implementation")).toEqual(["BOTH-01 UNKNOWN meaning-not-decidable"]);
    expect(subjects(r, "test-coverage")).toEqual(["BOTH-01 PARTIAL no-related-test"]);
    // The seed is listed once although two links lead to BOTH-01.
    expect(claims(r, "requirement-implementation")[0]?.observed).toBe("rank/rank.ts#rank implement BOTH-01 (declared or annotated link; meaning not checked)");
  });

  it("D: the existing symbol-linked result is unchanged", () => {
    const r = result("SYM");
    expect(subjects(r, "requirement-implementation")).toEqual(["SYM-01 UNKNOWN meaning-not-decidable"]);
    expect(subjects(r, "test-coverage")).toEqual(["SYM-01 PARTIAL no-related-test"]);
    expect(subjects(r, "decision-governance")).toEqual([]);
  });

  it("D: unrelated Requirements are not pulled in", () => {
    for (const name of Object.keys(SCENARIOS)) {
      const ids = result(name).claims.map((c) => c.subject.id);
      expect(ids, name).not.toContain("OTHER-01");
    }
    expect(subjects(result("A"), "test-coverage").map((s) => s.split(" ")[0])).toEqual(["SCORE-01"]);
  });

  it("D: H-100 keeps another milestone's Requirement reached through the owner file informational", () => {
    const r = result("OLD");
    const req = claims(r, "requirement-implementation");
    expect(req.map((c) => `${c.subject.kind} ${c.subject.id} ${c.alignment} ${c.reason} ${String(c.informational)}`)).toEqual([
      "file legacy/old.ts PARTIAL outside-current-milestone true",
    ]);
    expect(req[0]?.observed).toBe("legacy/old.ts#oldScore implement OLD-01 (milestone M2)");
    for (const c of req) expect(r.verdictBasis.warn).not.toContain(c.id);
  });

  it("D: forbids.paths still BLOCKs a body change inside a symbol in a forbidden file", () => {
    const r = result("FORBID");
    expect(r.verdict).toBe("BLOCK");
    expect(subjects(r, "decision-forbids")).toEqual(["D-002 CONFLICT forbidden-path"]);
  });

  it("E: test-coverage keeps its rules: a newly reported Requirement without a related test is PARTIAL (TypeScript tests are analyzable)", () => {
    const r = result("A");
    expect(subjects(r, "test-coverage")).toEqual(["SCORE-01 PARTIAL no-related-test"]);
    const partial = claims(r, "test-coverage")[0];
    // The WARN comes only from that existing test-coverage rule (accepted by H-105), not from a new policy.
    expect(r.verdict).toBe("WARN");
    expect(r.verdictBasis.warn).toEqual([partial?.id]);
  });
});
