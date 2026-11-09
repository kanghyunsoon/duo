/**
 * #160 Stage 2, C/C++ includes (H-103): a quoted #include resolves against the includer's directory and the indexed
 * file set, which describes the working tree. A header that the reviewed snapshot has and the working tree lacks gave
 * a false PASS under --staged and --to (reproduced on next 7cb6ec9,
 * https://github.com/kanghyunsoon/duo/issues/160#issuecomment-6705406691). Such a header is now a verdict input, so the
 * review fails with the existing REVIEW_SNAPSHOT_MISMATCH (no verdict).
 *
 * A1, A2 and C1 fail without the change (false PASS). B and C2 pin the other direction (a header that exists only in
 * the working tree must not BLOCK). D, E and F pin what must not change: WORKTREE reviews, working-tree edits that do
 * not change the include, and a system include.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry, GitDiffEnd } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureAdoptionBaseline } from "../adoption/baseline.js";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { reviewChanges } from "./review.js";
import type { ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
const human = { kind: "human" as const, name: "Ada" };
const at = (iso: string) => () => new Date(iso);
const PAGE = "src/ui/page.cpp";
const TARGET = "src/db/legacy.h";
const SAME_DIR = "#include \"../db/legacy.h\"\n\nint page() { return legacy(); }\n";
const NESTED = "#include \"../ui/../db/legacy.h\"\n\nint page() { return legacy(); }\n";
const HEADER = "int legacy();\n";

const FILES: Record<string, string> = {
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: issue160-cpp\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001", "title: Nothing includes legacy.h", "kind: decision", "state: proposed", "question: legacy_h_include",
    "answer: no code includes src/db/legacy.h", "forbids:", "  imported_paths: [src/db/legacy.h]", "enforcement: block", "",
  ].join("\n"),
  [TARGET]: HEADER,
  "src/db/other.h": "int other();\n",
  "src/ui/home.cpp": "int home() { return 1; }\n",
};

type Outcome = { readonly result: ReviewResult | undefined; readonly codes: readonly string[]; readonly messages: readonly string[] };

async function review(diff: { readonly from: GitDiffEnd; readonly to: GitDiffEnd }): Promise<Outcome> {
  await repo.index();
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const out = await reviewChanges(repo.root, { diff }, { graph: opened.value, registry, historyWindow: HISTORY });
    return { result: out.value?.result, codes: out.diagnostics.map((d) => d.code), messages: out.diagnostics.map((d) => d.message) };
  } finally {
    opened.value.close();
  }
}
const STAGED = { from: "HEAD", to: "INDEX" } as const;
const WORKTREE = { from: "HEAD", to: "WORKTREE" } as const;
const RANGE = () => ({ from: { commit: repo.git("rev-parse", "HEAD~1").trim() }, to: { commit: repo.git("rev-parse", "HEAD").trim() } }) as const;

function reset(): void {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
}
/** Stage the importer with text, then apply working-tree-only edits. */
function staged(text: string, worktree: () => void = () => undefined): void {
  reset();
  repo.write(PAGE, text);
  repo.git("add", PAGE);
  worktree();
}
const remove = (file: string) => fs.rmSync(path.join(repo.root, file));
const forbidden = (o: Outcome) => (o.result?.claims ?? []).filter((c) => c.rule === "decision-forbids-import");
function expectMismatch(o: Outcome, ...paths: string[]): void {
  expect(o.result, JSON.stringify({ verdict: o.result?.verdict, claims: forbidden(o).map((c) => c.observed) })).toBeUndefined();
  expect(o.codes).toContain("REVIEW_SNAPSHOT_MISMATCH");
  for (const p of paths) expect(o.messages.join("\n")).toContain(p);
}
function expectBlock(o: Outcome): void {
  expect(o.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
  expect(o.result?.verdict, JSON.stringify(o.codes)).toBe("BLOCK");
  expect(forbidden(o).map((c) => c.observed).join("\n")).toContain(`resolves to ${TARGET}`);
}

beforeAll(async () => {
  registry = await contextRegistry();
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue160-cpp-")));
  temps.push(fixture);
  for (const [f, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true });
    fs.writeFileSync(path.join(fixture, f), text);
  }
  repo = makeContextRepo(temps, registry, fixture);
  const confirmed = await createDecisionService({ root: repo.root, clock: at("2026-09-01T00:00:00.000Z") }).confirm(human, "D-001");
  if (confirmed.value === undefined) throw new Error(JSON.stringify(confirmed.diagnostics));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "confirm D-001");
  await repo.index();
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const b = await captureAdoptionBaseline(repo.root, { graph: opened.value, registry, historyWindow: HISTORY, actor: human, clock: at("2026-09-02T00:00:00.000Z") });
    if (b.value === undefined || b.value.status === "aborted") throw new Error(JSON.stringify(b));
  } finally {
    opened.value.close();
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "capture adoption baseline");
});

afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

describe("#160 Stage 2, C/C++ includes (H-103): the included header's existence is read from both sides", () => {
  it.each([["A1 parent-relative", SAME_DIR], ["A2 normalized", NESTED]] as const)("%s --staged: the header deleted only in the working tree is not a PASS", async (_label, text) => {
    staged(text);
    expectBlock(await review(STAGED));
    staged(text, () => remove(TARGET));
    expectMismatch(await review(STAGED), TARGET);
  });

  it("B --staged: a header that exists only in the working tree does not BLOCK the snapshot", async () => {
    reset();
    repo.git("rm", "-q", TARGET);
    repo.git("commit", "-q", "-m", "drop legacy.h");
    try {
      staged(SAME_DIR);
      const clean = await review(STAGED);
      expect(clean.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
      expect(clean.result?.verdict).not.toBe("BLOCK");
      staged(SAME_DIR, () => repo.write(TARGET, HEADER));
      expectMismatch(await review(STAGED), TARGET);
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("C1/C2 --from/--to: the same two directions for a committed range", async () => {
    reset();
    repo.write(PAGE, SAME_DIR);
    repo.git("add", PAGE);
    repo.git("commit", "-q", "-m", "page includes legacy.h");
    try {
      expectBlock(await review(RANGE()));
      remove(TARGET);
      expectMismatch(await review(RANGE()), TARGET); // C1: false PASS before
      reset();
      repo.git("rm", "-q", TARGET);
      repo.git("commit", "-q", "-m", "drop legacy.h");
      try {
        const clean = await review(RANGE());
        expect(clean.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
        repo.write(TARGET, HEADER);
        expectMismatch(await review(RANGE()), TARGET); // C2: never a BLOCK from the working tree
      } finally {
        reset();
        repo.git("reset", "-q", "--hard", "HEAD~1");
      }
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("D WORKTREE: the working tree is the reviewed side, so a deleted header is reviewed as it is (no mismatch)", async () => {
    reset();
    repo.write(PAGE, SAME_DIR);
    remove(TARGET);
    const o = await review(WORKTREE);
    expect(o.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
    expect(o.result).toBeDefined();
    expect(forbidden(o)).toEqual([]);
    reset();
  });

  it("E --staged: working-tree edits that do not change the include keep the verdict and the limitation", async () => {
    staged(SAME_DIR, () => {
      remove("src/db/other.h"); // another header of the same directory
      repo.write("src/ui/home.cpp", "int home() { return 2; }\n");
      repo.write("src/ui/legacy.h", "int not_the_target();\n"); // same name, another directory
    });
    const o = await review(STAGED);
    expectBlock(o);
    expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
    reset();
  });

  it("F --staged: a system include is not resolved against repository files on either side", async () => {
    staged("#include <legacy.h>\n#include \"../db/legacy.h\"\n\nint page() { return legacy(); }\n", () => repo.write("legacy.h", "int system_like();\n"));
    expectBlock(await review(STAGED));
    reset();
  });
});
