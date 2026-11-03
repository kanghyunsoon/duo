/**
 * #160 (P1): review --staged / --to must not decide from a working-tree file that a rule read when that file differs
 * from the reviewed snapshot. Regression cases 1-8 from the issue, plus an unrelated working-tree edit.
 *
 * Cases 1-5 fail on next 1306dba: a false PASS (1, 3, 5), a PASS for a snapshot whose verdict input differs (2) and a
 * false BLOCK (4). Stage 1 (H-103, pending a Maintainer decision) expects the existing REVIEW_SNAPSHOT_MISMATCH,
 * naming the differing input, with no verdict. Cases 6-9 pin what must not change: WORKTREE reviews, clean controls,
 * the H-82 changed-path check and an unrelated working-tree edit (verdict plus reviewed-side-context-from-working-tree).
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
const reexport = (from: string) => 'export { legacyQuery } from "' + from + '";\n';
const PAGE = "src/ui/page.ts";
const importFrom = (specifier: string) => 'import { legacyQuery } from "' + specifier + '";\n\nexport const page = (): string => legacyQuery("x");\n';

const FILES: Record<string, string> = {
  "package.json": '{ "name": "issue160-fixture", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: issue160-fixture\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001", "title: Nothing imports legacy-db", "kind: decision", "state: proposed", "question: legacy_db_import",
    "answer: no code imports src/db/legacy-db.ts", "forbids:", "  imported_paths: [src/db/legacy-db.ts]", "enforcement: block", "",
  ].join("\n"),
  "src/db/legacy-db.ts": "export function legacyQuery(sql: string): string {\n  return sql;\n}\n",
  "src/db/safe.ts": "export function legacyQuery(sql: string): string {\n  return sql.toUpperCase();\n}\n",
  // index -> mid -> legacy-db (the forbidden chain) and back -> safe (the allowed one).
  "src/db/mid.ts": reexport("./legacy-db.js"),
  "src/db/index.ts": reexport("./mid.js"),
  "src/db/back.ts": reexport("./safe.js"),
  "src/ui/home.ts": "export const home = 1;\n",
};

type Outcome = { readonly result?: ReviewResult; readonly codes: readonly string[]; readonly messages: readonly string[] };

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

function reset(): void {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
}
/** Stage the importer, then apply working-tree-only edits. */
function staged(specifier: string, worktree: () => void = () => undefined): void {
  reset();
  repo.write(PAGE, importFrom(specifier));
  repo.git("add", PAGE);
  worktree();
}

const forbidden = (o: Outcome) => (o.result?.claims ?? []).filter((c) => c.rule === "decision-forbids-import");
/** Stage 1 (H-103): no verdict, the existing code, and the differing verdict input named in the message. */
function expectMismatch(o: Outcome, ...paths: string[]): void {
  expect(o.result, JSON.stringify({ verdict: o.result?.verdict, claims: forbidden(o).map((c) => c.observed) })).toBeUndefined();
  expect(o.codes).toContain("REVIEW_SNAPSHOT_MISMATCH");
  for (const p of paths) expect(o.messages.join("\n")).toContain(p);
}
function expectBlock(o: Outcome): void {
  expect(o.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
  expect(o.result?.verdict).toBe("BLOCK");
  expect(forbidden(o).map((c) => c.provenance)).toEqual(["introduced"]);
}

beforeAll(async () => {
  registry = await contextRegistry();
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue160-fixture-")));
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

describe("#160: a verdict input outside the diff that differs from the reviewed snapshot", () => {
  it("1 --staged: a re-export hop changed only in the working tree is not a PASS", async () => {
    // Staged: page -> index -> mid -> legacy-db (forbidden). Working tree only: mid -> safe.
    staged("../db/index.js", () => repo.write("src/db/mid.ts", reexport("./safe.js")));
    expectMismatch(await review(STAGED), "src/db/mid.ts");
  });

  it("2 --staged: a hop that reaches the forbidden file only in the working tree gives no claim", async () => {
    // Staged: page -> back -> safe. Working tree only: back -> legacy-db.
    staged("../db/back.js", () => repo.write("src/db/back.ts", reexport("./legacy-db.js")));
    expectMismatch(await review(STAGED), "src/db/back.ts");
  });

  it("3 --staged: an import target deleted only in the working tree is not a PASS", async () => {
    staged("../db/legacy-db.js", () => fs.rmSync(path.join(repo.root, "src/db/legacy-db.ts")));
    expectMismatch(await review(STAGED), "src/db/legacy-db.ts");
  });

  it("4 --staged: an import target that exists only in the working tree (untracked) is not a BLOCK", async () => {
    reset();
    repo.git("rm", "-q", "--cached", "src/db/legacy-db.ts");
    repo.git("commit", "-q", "-m", "legacy-db leaves the repository; the file stays untracked");
    try {
      // No reset here: git clean would delete the untracked target this case needs.
      repo.write(PAGE, importFrom("../db/legacy-db.js"));
      repo.git("add", PAGE);
      expect(fs.existsSync(path.join(repo.root, "src/db/legacy-db.ts"))).toBe(true);
      expectMismatch(await review(STAGED), "src/db/legacy-db.ts");
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("5 --to <commit>: cases 1 and 3 against a commit range", async () => {
    for (const [specifier, edit, input] of [
      ["../db/index.js", () => repo.write("src/db/mid.ts", reexport("./safe.js")), "src/db/mid.ts"],
      ["../db/legacy-db.js", () => fs.rmSync(path.join(repo.root, "src/db/legacy-db.ts")), "src/db/legacy-db.ts"],
    ] as const) {
      staged(specifier);
      repo.git("commit", "-q", "-m", "page");
      const head = repo.git("rev-parse", "HEAD").trim();
      try {
        edit();
        expectMismatch(await review({ from: { commit: head + "~1" }, to: { commit: head } }), input);
      } finally {
        reset();
        repo.git("reset", "-q", "--hard", "HEAD~1");
      }
    }
  });

  it("6 WORKTREE reviews are unchanged", async () => {
    staged("../db/index.js", () => repo.write("src/db/mid.ts", reexport("./safe.js")));
    const safe = await review(WORKTREE);
    expect(safe.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
    expect(safe.result?.verdict).toBe("PASS");
    expect(forbidden(safe)).toEqual([]);
    staged("../db/legacy-db.js");
    expectBlock(await review(WORKTREE));
  });

  it("7 a clean working tree still gives BLOCK for --staged and --to", async () => {
    staged("../db/index.js");
    expectBlock(await review(STAGED));
    repo.git("commit", "-q", "-m", "page");
    const head = repo.git("rev-parse", "HEAD").trim();
    try {
      expectBlock(await review({ from: { commit: head + "~1" }, to: { commit: head } }));
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("8 a changed path that differs is still REVIEW_SNAPSHOT_MISMATCH (H-82)", async () => {
    staged("../db/index.js", () => repo.write(PAGE, importFrom("../db/back.js")));
    expectMismatch(await review(STAGED), PAGE);
  });

  it("9 an unrelated working-tree edit keeps the verdict and the limitation", async () => {
    staged("../db/index.js", () => repo.write("src/ui/home.ts", "export const home = 2;\n"));
    const o = await review(STAGED);
    expectBlock(o);
    expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
  });
});

