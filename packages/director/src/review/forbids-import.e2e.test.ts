/**
 * T37 (H-72): Decision forbids.imported_paths. A module reference on a changed new-side line whose indexed
 * resolution is exactly one repository file matching the pattern is CONFLICT forbidden-import. Not a claim
 * that the import is new. Unresolved, ambiguous, unsupported and external references never conflict;
 * the first three are limitations. Adoption Baseline coverage (evaluatedRules) decides provenance.
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
const fileNode = (p: string) => nodeId(fileRef(p as RepoPath));

const FILES: Record<string, string> = {
  "package.json": '{ "name": "imports-app", "type": "module" }\n',
  "tsconfig.json": '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "baseUrl": ".", "paths": { "@legacy/*": ["src/legacy/*"] }, "allowJs": true, "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": "schema_version: 1\nname: imports-app\n",
  ".duo-project/decisions/D-001.yaml": [
    "id: D-001", "title: No imports of the legacy data layer", "kind: decision", "state: proposed", "question: legacy_imports",
    "answer: code does not import src/legacy, the Python legacy module or the C++ legacy header",
    "forbids:", "  imported_paths: [src/legacy/**, src/py/legacy_mod.py, src/cpp/legacy.h, src/future/**]", "enforcement: block", "",
  ].join("\n"),
  "src/legacy/db.ts": "export class LegacyDb {\n  run(sql: string): string {\n    return sql;\n  }\n}\n\nexport interface Row {\n  readonly id: string;\n}\n",
  "src/legacy/old.js": "module.exports = { old: true };\n",
  "src/db/client.ts": "export class DbClient {\n  query(sql: string): string {\n    return sql;\n  }\n}\n",
  "src/app/existing.ts": 'import { LegacyDb } from "../legacy/db";\n\nexport function existing(): string {\n  return new LegacyDb().run("select 1");\n}\n\nexport function other(): number {\n  return 1;\n}\n',
  "src/app/clean.ts": 'import { DbClient } from "../db/client";\n\nexport function clean(): string {\n  return new DbClient().query("x");\n}\n',
  "src/py/__init__.py": "",
  "src/py/legacy_mod.py": "def legacy():\n    return 1\n",
  "src/py/user.py": "def user():\n    return 2\n",
  "shared.py": "VALUE = 1\n",
  "src/shared.py": "VALUE = 2\n",
  "src/cpp/legacy.h": "int legacy();\n",
  "src/cpp/user.cpp": "int user() {\n  return 1;\n}\n",
  "src/java/App.java": "package app;\n\npublic class App {\n}\n",
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-imports-fixture-")));
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
  try { return await fn(opened.value); } finally { opened.value.close(); }
}
async function confirm(r: ContextRepo, id: string, when: string): Promise<void> {
  const c = await createDecisionService({ root: r.root, clock: at(when) }).confirm(human, id);
  if (c.value === undefined) throw new Error(JSON.stringify(c.diagnostics));
  r.git("add", "-A");
  r.git("commit", "-q", "-m", `confirm ${id}`);
}
async function capture(r: ContextRepo, when: string, policy?: "HEAD_BASELINE") {
  await r.index();
  const c = await withGraph(r.root, (graph) => captureAdoptionBaseline(r.root, { graph, registry, historyWindow: HISTORY, actor: human, clock: at(when), ...(policy === undefined ? {} : { policy }) }));
  if (c.value === undefined || c.value.status === "aborted") throw new Error(JSON.stringify(c));
  return c.value.baseline;
}
async function review(r: ContextRepo): Promise<ReviewResult> {
  await r.index();
  return withGraph(r.root, async (graph) => {
    const out = await reviewChanges(r.root, { diff: W }, { graph, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value.result;
  });
}
/** A repository whose D-001 was confirmed (and committed) at the given time. */
async function repoWith(confirmedAt = "2026-09-01T00:00:00.000Z"): Promise<ContextRepo> {
  const r = makeContextRepo(temps, registry, fixture);
  await confirm(r, "D-001", confirmedAt);
  return r;
}
const imports = (res: ReviewResult) => res.claims.filter((c) => c.rule === "decision-forbids-import");
const limits = (res: ReviewResult) => res.limitations.map((l) => l.code).filter((c) => c.startsWith("imports-"));
const NEW_WORDING = /\bnew(?:ly)?\b|introduc|added/iu;
function expectWording(c: ReviewClaim): void {
  expect(c.reason).toBe("forbidden-import");
  expect(c.observed).toMatch(/^forbidden import on a changed line: /u);
  expect(`${c.observed} ${c.expected}`).not.toMatch(NEW_WORDING);
}

describe("T37 decision-forbids-import: exact changed-line imports (no Adoption Baseline)", () => {
  let repo: ContextRepo;
  beforeAll(async () => { repo = await repoWith(); });
  const scenario = async (mutate: (r: ContextRepo) => void) => {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
    mutate(repo);
    return review(repo);
  };
  const blocked = (res: ReviewResult, source: string, target: string) => {
    const c = imports(res).find((x) => x.observed.includes(`${source}:`) && x.observed.endsWith(`resolves to ${target}`));
    expect(c, JSON.stringify(res.claims.map((x) => x.observed))).toBeDefined();
    expect(c).toMatchObject({ alignment: "CONFLICT", enforced: true, blockEligible: true, subject: { kind: "decision", id: "D-001" } });
    expectWording(c as ReviewClaim);
    expect(res.verdict).toBe("BLOCK");
    return c as ReviewClaim;
  };

  it("1 a direct import on a changed line blocks; the evidence chain is Decision, statement, hunk and target file", async () => {
    const res = await scenario((r) => r.write("src/app/direct.ts", 'import { LegacyDb } from "../legacy/db";\n\nexport const direct = new LegacyDb();\n'));
    const c = blocked(res, "src/app/direct.ts", "src/legacy/db.ts");
    const ev = c.evidenceIds.map((id) => res.evidence.find((e) => e.id === id));
    expect(ev.map((e) => `${e?.basis}:${e?.kind}`).sort()).toEqual(["git:diff", "project-truth:decision", "repository:file", "repository:file"]);
    expect(ev.find((e) => e?.metadata?.moduleReference === "import")).toMatchObject({ pointer: { path: "src/app/direct.ts", lines: [1, 1] }, metadata: { specifier: "../legacy/db", resolvedTo: "src/legacy/db.ts", typeOnly: false } });
    expect(c.violationKey).toBe(violationKey("decision-forbids-import", "D-001", `import:${fileNode("src/app/direct.ts")}->${fileNode("src/legacy/db.ts")}`));
  });

  it("2-7 alias, tsconfig path alias, export-from, dynamic import, require and import type all resolve and block", async () => {
    const cases: [string, string, string][] = [
      ["src/app/alias.ts", 'import { LegacyDb as L } from "../legacy/db";\n\nexport const a = new L();\n', "src/legacy/db.ts"],
      ["src/app/paths.ts", 'import { LegacyDb } from "@legacy/db";\n\nexport const p = new LegacyDb();\n', "src/legacy/db.ts"],
      ["src/app/barrel.ts", 'export { LegacyDb } from "../legacy/db";\n', "src/legacy/db.ts"],
      ["src/app/lazy.ts", 'export async function load(): Promise<unknown> {\n  return import("../legacy/db");\n}\n', "src/legacy/db.ts"],
      ["src/app/req.cjs", 'const legacy = require("../legacy/old.js");\n\nmodule.exports = { legacy };\n', "src/legacy/old.js"],
      ["src/app/types.ts", 'import type { Row } from "../legacy/db";\n\nexport const row: Row = { id: "1" };\n', "src/legacy/db.ts"],
    ];
    for (const [file, text, target] of cases) {
      const res = await scenario((r) => r.write(file, text));
      const c = blocked(res, file, target);
      if (file.endsWith("types.ts")) expect(c.observed).toContain("(type-only)");
    }
  });

  it("8 an unrelated changed line in a file with a forbidden import does not conflict", async () => {
    const res = await scenario((r) => r.edit("src/app/existing.ts", "return 1;", "return 2;"));
    expect(imports(res)).toEqual([]);
    expect(res.verdict).not.toBe("BLOCK");
  });

  it("9 editing the existing import line blocks, and the claim never calls it new", async () => {
    const res = await scenario((r) => r.edit("src/app/existing.ts", 'import { LegacyDb } from "../legacy/db";', 'import { LegacyDb, type Row } from "../legacy/db";'));
    const c = blocked(res, "src/app/existing.ts", "src/legacy/db.ts");
    expect(c.observed).toBe('forbidden import on a changed line: src/app/existing.ts:1 import "../legacy/db" resolves to src/legacy/db.ts');
  });

  it("10/11 a target the patterns do not match, and a pattern no file matches (src/future/**), give nothing", async () => {
    const res = await scenario((r) => r.write("src/app/fine.ts", 'import { DbClient } from "../db/client";\n\nexport const f = new DbClient();\n'));
    expect(imports(res)).toEqual([]);
    expect(limits(res)).toEqual([]);
    expect(res.diagnostics).toEqual([]);
    expect(res.verdict).not.toBe("BLOCK");
  });

  it("12/13 unresolved and ambiguous changed imports never block; they are limitations, not text guesses", async () => {
    const unresolved = await scenario((r) => r.write("src/app/missing.ts", 'import { legacy } from "./legacy-db-missing";\n\nexport const m = legacy;\n'));
    expect(imports(unresolved)).toEqual([]);
    expect(limits(unresolved)).toEqual(["imports-unresolved"]);
    expect(unresolved.limitations.find((l) => l.code === "imports-unresolved")?.message).toContain("src/app/missing.ts:1");
    const ambiguous = await scenario((r) => r.edit("src/py/user.py", "def user():", "import shared\n\n\ndef user():"));
    expect(imports(ambiguous)).toEqual([]);
    expect([...limits(ambiguous)].sort()).toEqual(["imports-ambiguous", "imports-partial"]); // reference-level + the Python capability limitation
    for (const res of [unresolved, ambiguous]) expect(res.claims.filter((c) => c.alignment !== "ALIGNED" && c.rule === "decision-forbids-import")).toEqual([]);
  });

  it("14 an external package is not an imported_paths claim and not a limitation", async () => {
    const res = await scenario((r) => r.write("src/app/ext.ts", 'import fs from "node:fs";\nimport left from "left-pad";\n\nexport const e = [fs, left];\n'));
    expect(imports(res)).toEqual([]);
    expect(limits(res)).toEqual([]);
  });

  it("15/16 a resolved Python import and a C++ quoted include block", async () => {
    const py = await scenario((r) => r.edit("src/py/user.py", "def user():", "from .legacy_mod import legacy\n\n\ndef user():"));
    blocked(py, "src/py/user.py", "src/py/legacy_mod.py");
    const cpp = await scenario((r) => r.edit("src/cpp/user.cpp", "int user() {", '#include "legacy.h"\n\nint user() {'));
    blocked(cpp, "src/cpp/user.cpp", "src/cpp/legacy.h");
  });

  it("17 Java imports are not resolved: no claim, no BLOCK, an exact limitation", async () => {
    const res = await scenario((r) => r.edit("src/java/App.java", "package app;", "package app;\n\nimport legacy.LegacyDb;"));
    expect(imports(res)).toEqual([]);
    expect(res.verdict).not.toBe("BLOCK");
    expect([...limits(res)].sort()).toEqual(["imports-resolution-unsupported", "imports-syntactic"]); // reference-level + the Java capability limitation
  });

  it("20 several changed statements of one source → target are one violation with each statement as evidence", async () => {
    const res = await scenario((r) => r.write("src/app/two.ts", 'import { LegacyDb } from "../legacy/db";\nimport type { Row } from "../legacy/db";\n\nexport const t: [LegacyDb, Row?] = [new LegacyDb()];\n'));
    expect(imports(res)).toHaveLength(1);
    const c = blocked(res, "src/app/two.ts", "src/legacy/db.ts");
    expect(c.evidenceIds.map((id) => res.evidence.find((e) => e.id === id)).filter((e) => e?.metadata?.moduleReference !== undefined)).toHaveLength(2);
  });
});

describe("T37 Adoption Baseline coverage and provenance (H-72)", () => {
  const recordPath = (r: ContextRepo) => path.join(r.root, loadAdoptionBaseline(r.root).path ?? "");
  /** A baseline as it was recorded before T37: same body without evaluatedRules and import findings, id recomputed. */
  function makeOld(r: ContextRepo): void {
    const file = recordPath(r);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & { findings: { rule: string }[] };
    const rest: Record<string, unknown> = { ...record };
    const recorded = rest.recorded;
    delete rest.id;
    delete rest.recorded;
    delete rest.evaluatedRules;
    const body = { ...rest, findings: record.findings.filter((f) => f.rule !== "decision-forbids-import") };
    const id = historyRecordId("adoption", body);
    fs.rmSync(file);
    fs.writeFileSync(path.join(r.root, REVIEWS_DIR, `${id}.json`), `${JSON.stringify({ id, recorded, ...body }, null, 2)}\n`);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "baseline from before T37");
    expect(loadAdoptionBaseline(r.root)).toMatchObject({ status: "present", baseline: { id } });
    expect(loadAdoptionBaseline(r.root).baseline?.evaluatedRules).toBeUndefined();
  }
  const commitBaseline = (r: ContextRepo) => { r.git("add", "-A"); r.git("commit", "-q", "-m", "baseline"); };
  const editExistingImport = (r: ContextRepo) => r.edit("src/app/existing.ts", 'import { LegacyDb } from "../legacy/db";', 'import { LegacyDb, type Row } from "../legacy/db";');
  const addImport = (r: ContextRepo) => r.write("src/app/direct.ts", 'import { LegacyDb } from "../legacy/db";\n\nexport const direct = new LegacyDb();\n');

  it("A/18 a clean baseline records the rule as evaluated and the existing relation; editing that import line does not block", async () => {
    const r = await repoWith("2026-09-01T00:00:00.000Z");
    const b = await capture(r, "2026-09-28T00:00:00.000Z");
    expect(b.evaluatedRules).toEqual(["decision-forbids", "decision-forbids-import", "declared-reference", "external-source-drift"]);
    const key = violationKey("decision-forbids-import", "D-001", `import:${fileNode("src/app/existing.ts")}->${fileNode("src/legacy/db.ts")}`);
    expect(b.findings.filter((f) => f.rule === "decision-forbids-import").map((f) => f.key)).toEqual([key]);
    commitBaseline(r);
    editExistingImport(r);
    const res = await review(r);
    expect(imports(res)).toHaveLength(1);
    expect(imports(res)[0]).toMatchObject({ provenance: "pre-existing-touched", blockEligible: false, violationKey: key });
    expect(res.verdict).toBe("WARN");
    // A relation that was not there at adoption still blocks under the same baseline.
    r.git("reset", "-q", "--hard");
    addImport(r);
    expect(imports(await review(r))[0]).toMatchObject({ provenance: "introduced", blockEligible: true });
  });

  it("19 a Decision confirmed after a covering baseline: its relations are not in the baseline and block", async () => {
    const r = makeContextRepo(temps, registry, fixture);
    await capture(r, "2026-09-28T00:00:00.000Z");
    commitBaseline(r);
    await confirm(r, "D-001", "2026-10-01T00:00:00.000Z");
    editExistingImport(r);
    expect(imports(await review(r))[0]).toMatchObject({ provenance: "introduced", blockEligible: true });
  });

  it("B/F an old baseline (no evaluatedRules) and a Decision from before it: unverified-at-adoption, never BLOCK; the record is not rewritten", async () => {
    const r = await repoWith("2026-09-01T00:00:00.000Z");
    await capture(r, "2026-09-28T00:00:00.000Z");
    commitBaseline(r);
    makeOld(r);
    const before = fs.readFileSync(recordPath(r));
    addImport(r);
    const res = await review(r);
    expect(imports(res)[0]).toMatchObject({ alignment: "CONFLICT", provenance: "unverified-at-adoption", blockEligible: false });
    expect(res.verdict).not.toBe("BLOCK");
    expect(fs.readFileSync(recordPath(r)).equals(before)).toBe(true);
  });

  it("C an old baseline and a Decision confirmed after it: an exact violation can block", async () => {
    const r = makeContextRepo(temps, registry, fixture);
    await capture(r, "2026-09-28T00:00:00.000Z");
    commitBaseline(r);
    makeOld(r);
    await confirm(r, "D-001", "2026-10-01T00:00:00.000Z");
    addImport(r);
    const res = await review(r);
    expect(imports(res)[0]).toMatchObject({ provenance: "introduced", blockEligible: true });
    expect(res.verdict).toBe("BLOCK");
  });

  it("D an old baseline and a Decision whose confirmed_at is missing or not a time: unverified, no BLOCK", async () => {
    for (const replace of [(t: string) => t.replace(/^confirmed_at: .*\n/mu, ""), (t: string) => t.replace(/^confirmed_at: .*$/mu, "confirmed_at: sometime later")]) {
      const r = makeContextRepo(temps, registry, fixture);
      await capture(r, "2026-09-28T00:00:00.000Z");
      commitBaseline(r);
      makeOld(r);
      await confirm(r, "D-001", "2026-10-01T00:00:00.000Z");
      r.write(".duo-project/decisions/D-001.yaml", replace(r.read(".duo-project/decisions/D-001.yaml")));
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "confirmed_at unknown");
      addImport(r);
      const res = await review(r);
      expect(imports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false });
      expect(res.verdict).not.toBe("BLOCK");
    }
  });

  it("E a dirty HEAD_BASELINE does not claim import coverage; a pre-baseline Decision's violation is unverified", async () => {
    const r = await repoWith("2026-09-01T00:00:00.000Z");
    r.edit("src/app/clean.ts", 'query("x")', 'query("y")');
    const b = await capture(r, "2026-09-28T00:00:00.000Z", "HEAD_BASELINE");
    expect(b.evaluatedRules).toEqual(["decision-forbids", "declared-reference", "external-source-drift"]);
    expect(b.limitations).toContain("import-relations-not-evaluated-dirty-working-tree");
    r.git("add", REVIEWS_DIR);
    r.git("commit", "-q", "-m", "baseline");
    addImport(r);
    const res = await review(r);
    expect(imports(res)[0]).toMatchObject({ provenance: "unverified-at-adoption", blockEligible: false });
  });
});
