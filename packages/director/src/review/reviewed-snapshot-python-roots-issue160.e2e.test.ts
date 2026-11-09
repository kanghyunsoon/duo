/**
 * #160 Stage 2, Python source roots (H-103, #189 review): the root-changing branch of the Python check. A metadata
 * root (pyproject.toml with [project]) or a package root (a top-level package's __init__.py) that the reviewed
 * snapshot has and the working tree lacks moves where an absolute import resolves. Before #189 both gave a false PASS
 * under --staged; #189 fails them with REVIEW_SNAPSHOT_MISMATCH naming the file that decided the root. A metadata edit
 * that does not change the root keeps the verdict.
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
const META_PAGE = "proj/ui/page.py";
const META_TARGET = "proj/db/legacy_db.py";
const PKG_PAGE = "lib/pkg/page.py";
const PKG_TARGET = "lib/pkg/legacy.py";
const PYPROJECT = "proj/pyproject.toml";
const PROJECT_TEXT = "[project]\nname = \"proj\"\n";
const META_IMPORT = "from db.legacy_db import legacy_query\n\n\ndef page():\n    return legacy_query(\"x\")\n";
const PKG_IMPORT = "from pkg.legacy import legacy\n\n\ndef page():\n    return legacy()\n";

const FILES: Record<string, string> = {
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n__pycache__/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: issue160-python-roots\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001", "title: Nothing imports the legacy modules", "kind: decision", "state: proposed", "question: legacy_python_import",
    `answer: no code imports ${META_TARGET} or ${PKG_TARGET}`, "forbids:", `  imported_paths: [${META_TARGET}, ${PKG_TARGET}]`, "enforcement: block", "",
  ].join("\n"),
  [PYPROJECT]: PROJECT_TEXT,
  [META_TARGET]: "def legacy_query(sql):\n    return sql\n",
  "lib/pkg/__init__.py": "",
  [PKG_TARGET]: "def legacy():\n    return 1\n",
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

function reset(): void {
  repo.git("reset", "-q", "--hard");
  repo.git("clean", "-fdq");
}
/** Stage page with text, then apply working-tree-only edits. */
function staged(page: string, text: string, worktree: () => void = () => undefined): void {
  reset();
  repo.write(page, text);
  repo.git("add", page);
  worktree();
}
const remove = (file: string) => fs.rmSync(path.join(repo.root, file));
const forbidden = (o: Outcome) => (o.result?.claims ?? []).filter((c) => c.rule === "decision-forbids-import");
function expectMismatch(o: Outcome, ...paths: string[]): void {
  expect(o.result, JSON.stringify({ verdict: o.result?.verdict, claims: forbidden(o).map((c) => c.observed) })).toBeUndefined();
  expect(o.codes).toContain("REVIEW_SNAPSHOT_MISMATCH");
  for (const p of paths) expect(o.messages.join("\n")).toContain(p);
}
function expectBlock(o: Outcome, target: string): void {
  expect(o.codes).not.toContain("REVIEW_SNAPSHOT_MISMATCH");
  expect(o.result?.verdict, JSON.stringify(o.codes)).toBe("BLOCK");
  expect(forbidden(o).map((c) => c.observed).join("\n")).toContain(`resolves to ${target}`);
}

beforeAll(async () => {
  registry = await contextRegistry();
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue160-python-roots-")));
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

describe("#160 Stage 2, Python source roots (H-103): a root that differs between the sides is a verdict input", () => {
  it("a pyproject.toml that loses [project] only in the working tree is not a PASS", async () => {
    staged(META_PAGE, META_IMPORT);
    expectBlock(await review(STAGED), META_TARGET);
    staged(META_PAGE, META_IMPORT, () => repo.write(PYPROJECT, "[tool.black]\nline-length = 100\n"));
    expectMismatch(await review(STAGED), PYPROJECT);
    reset();
  });

  it("a package __init__.py deleted only in the working tree is not a PASS", async () => {
    staged(PKG_PAGE, PKG_IMPORT);
    expectBlock(await review(STAGED), PKG_TARGET);
    staged(PKG_PAGE, PKG_IMPORT, () => remove("lib/pkg/__init__.py"));
    expectMismatch(await review(STAGED), "lib/pkg/__init__.py");
    reset();
  });

  it("a pyproject.toml edit that keeps the root keeps the verdict and the limitation", async () => {
    staged(META_PAGE, META_IMPORT, () => repo.write(PYPROJECT, `${PROJECT_TEXT}# a comment\n`));
    const o = await review(STAGED);
    expectBlock(o, META_TARGET);
    expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
    reset();
  });
});
