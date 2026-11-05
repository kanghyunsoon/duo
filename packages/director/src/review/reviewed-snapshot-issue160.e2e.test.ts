/**
 * #160 (P1): review --staged / --to must not decide from a working-tree file that a rule read when that file differs
 * from the reviewed snapshot. Regression cases 1-8 from the issue, plus an unrelated working-tree edit.
 *
 * Cases 1-5, 11 and 12 fail on next 1306dba: a false PASS (1, 3, 5), a PASS for a snapshot whose verdict input differs
 * (2, 11) and a false BLOCK (4, 12). Stage 1 (H-103) expects the existing REVIEW_SNAPSHOT_MISMATCH, naming the
 * differing input, with no verdict. Cases 6-10 pin what must not change: WORKTREE reviews, clean controls, the H-82
 * changed-path check, and working-tree edits the verdict does not read (verdict plus
 * reviewed-side-context-from-working-tree).
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
  // star: two export * providers of legacyQuery in HEAD (ambiguous); plain provides it locally.
  "src/db/plain.ts": "export function legacyQuery(sql: string): string {\n  return sql.trim();\n}\n\nexport const plain = 1;\n",
  "src/db/star.ts": 'export * from "./legacy-db.js";\nexport * from "./plain.js";\n',
  // Mentions an export-from only in a comment and a string: it re-exports nothing.
  "src/ui/util.ts": '// Moved: export * from "../db/legacy-db.js";\nconst note = "export { legacyQuery } from \'./legacy\'";\n\nexport const util = note.length;\n',
  // A config of another directory: never applies to src/.
  "tools/tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
  "src/ui/home.ts": "export const home = 1;\n",
};
const ALIAS_TSCONFIG = (strict: boolean) =>
  '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": ' + String(strict) + ', "baseUrl": ".", "paths": { "@db/*": ["src/db/*"] } } }\n';

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

  it("10 an imported module that re-exports nothing on either side: a content edit keeps the verdict", async () => {
    reset();
    repo.write(PAGE, 'import { legacyQuery } from "../db/index.js";\nimport { util } from "./util.js";\n\nexport const page = (): string => legacyQuery(String(util));\n');
    repo.git("add", PAGE);
    repo.write("src/ui/util.ts", "export const util = 2;\n");
    const o = await review(STAGED);
    expectBlock(o);
    expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
  });

  it("11 --staged: resolver configuration changed only in the working tree is an input of a non-relative import", async () => {
    reset();
    repo.write("tsconfig.json", '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "baseUrl": ".", "paths": { "@db/*": ["src/db/*"] } } }\n');
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "path alias");
    try {
      repo.write(PAGE, importFrom("@db/legacy-db.js"));
      repo.git("add", PAGE);
      expectBlock(await review(STAGED));
      repo.write("tsconfig.json", '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "baseUrl": ".", "paths": { "@db/*": ["src/ui/*"] } } }\n');
      expectMismatch(await review(STAGED), "tsconfig.json");
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("12 --staged: the own exports of an export * target decide the provider", async () => {
    // Staged: star provides legacyQuery from legacy-db and from plain (ambiguous, no claim). Working tree only: plain
    // drops it, so the working tree has one exact origin (legacy-db) and would BLOCK.
    staged("../db/star.js", () => repo.write("src/db/plain.ts", "export const plain = 1;\n"));
    expectMismatch(await review(STAGED), "src/db/plain.ts");
  });

  it("13 --staged: a tsconfig change that does not affect resolution, or another directory's tsconfig, keeps the verdict", async () => {
    reset();
    repo.write("tsconfig.json", ALIAS_TSCONFIG(true));
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "path alias");
    try {
      repo.write(PAGE, importFrom("@db/legacy-db.js"));
      repo.git("add", PAGE);
      repo.write("tsconfig.json", ALIAS_TSCONFIG(false).replace("{ \"compilerOptions\"", "// no longer strict\n{ \"compilerOptions\""));
      repo.write("tools/tsconfig.json", '{ "compilerOptions": { "strict": false } }\n');
      expectBlock(await review(STAGED));
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("14 --staged: a differing module that mentions export-from only in a comment or a string keeps the verdict", async () => {
    reset();
    repo.write(PAGE, 'import { legacyQuery } from "../db/index.js";\nimport { util } from "./util.js";\n\nexport const page = (): string => legacyQuery(String(util));\n');
    repo.git("add", PAGE);
    repo.write("src/ui/util.ts", "export const util = 3;\n");
    const o = await review(STAGED);
    expectBlock(o);
    expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
  });

  it("15 --staged: a resolution option of the importer's tsconfig is an input of a relative import too", async () => {
    staged("../db/index.js", () => repo.write("tsconfig.json", '{ "compilerOptions": { "module": "CommonJS", "moduleResolution": "Node10", "strict": true } }\n'));
    expectMismatch(await review(STAGED), "tsconfig.json");
  });

  it("16 --staged: package.json keeps the verdict unless a field that decides resolution changes", async () => {
    staged("../db/index.js", () => repo.write("package.json", '{ "name": "issue160-fixture", "type": "module", "description": "unrelated" }\n'));
    expectBlock(await review(STAGED));
    staged("../db/index.js", () => repo.write("package.json", '{ "name": "issue160-fixture", "type": "commonjs" }\n'));
    expectMismatch(await review(STAGED), "package.json");
  });

  it.each([
    ["17 a tsconfig paths alias", "tsconfig.json", ALIAS_TSCONFIG(true), "@db/legacy-db.js"],
    ["18 a package.json imports subpath", "package.json", '{ "name": "issue160-fixture", "type": "module", "imports": { "#db/*": "./src/db/*" } }\n', "#db/legacy-db.js"],
  ] as const)("%s: the target deleted only in the working tree is not a PASS (case 3, non-relative)", async (_label, config, text, specifier) => {
    reset();
    repo.write(config, text);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "non-relative specifier");
    try {
      repo.write(PAGE, importFrom(specifier));
      repo.git("add", PAGE);
      expectBlock(await review(STAGED));
      fs.rmSync(path.join(repo.root, "src/db/legacy-db.ts"));
      expectMismatch(await review(STAGED), "src/db/legacy-db.ts");
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  // The specifier's last segment ("legacy") is not the target's name ("legacy-db"): only the resolver knows the path.
  const EXACT_ALIAS = [
    ["19 a tsconfig paths entry for one file", "tsconfig.json", '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "baseUrl": ".", "paths": { "@legacy": ["src/db/legacy-db.ts"] } } }\n', "@legacy"],
    ["20 a package.json imports entry for one file", "package.json", '{ "name": "issue160-fixture", "type": "module", "imports": { "#legacy": "./src/db/legacy-db.js" } }\n', "#legacy"],
  ] as const;
  async function withAlias(config: string, text: string, specifier: string, run: () => Promise<void>): Promise<void> {
    reset();
    repo.write(config, text);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "alias for one file");
    try {
      repo.write(PAGE, importFrom(specifier));
      repo.git("add", PAGE);
      await run();
    } finally {
      reset();
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  }

  it.each(EXACT_ALIAS)("%s: a target whose name differs from the specifier, deleted only in the working tree, is not a PASS", async (_label, config, text, specifier) => {
    await withAlias(config, text, specifier, async () => {
      expectBlock(await review(STAGED));
      fs.rmSync(path.join(repo.root, "src/db/legacy-db.ts"));
      expectMismatch(await review(STAGED), "src/db/legacy-db.ts");
    });
  });

  it.each(EXACT_ALIAS)("21 %s: files the resolver does not look up, deleted only in the working tree, keep the verdict", async (_label, config, text, specifier) => {
    await withAlias(config, text, specifier, async () => {
      fs.rmSync(path.join(repo.root, "src/db/safe.ts"));
      fs.rmSync(path.join(repo.root, "src/ui/home.ts"));
      const o = await review(STAGED);
      expectBlock(o);
      expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
    });
  });

  // #163 review (kang987654): TypeScript does not look up files in a directory it finds missing, so before this fix
  // deleting the target's whole directory only in the working tree gave a PASS for 17 and 20.
  const NON_RELATIVE = [
    ["17 a tsconfig paths alias", "tsconfig.json", ALIAS_TSCONFIG(true), "@db/legacy-db.js"],
    ["18 a package.json imports subpath", "package.json", '{ "name": "issue160-fixture", "type": "module", "imports": { "#db/*": "./src/db/*" } }\n', "#db/legacy-db.js"],
    ...EXACT_ALIAS,
  ] as const;

  it.each(NON_RELATIVE)("22 (%s): the target's whole directory deleted only in the working tree is not a PASS", async (_label, config, text, specifier) => {
    await withAlias(config, text, specifier, async () => {
      expectBlock(await review(STAGED));
      fs.rmSync(path.join(repo.root, "src/db"), { recursive: true, force: true });
      expectMismatch(await review(STAGED), "src/db/legacy-db.ts");
    });
  });

  it.each(NON_RELATIVE)("23 (%s): a directory the resolver does not look in, deleted only in the working tree, keeps the verdict", async (_label, config, text, specifier) => {
    await withAlias(config, text, specifier, async () => {
      fs.rmSync(path.join(repo.root, "tools"), { recursive: true, force: true });
      const o = await review(STAGED);
      expectBlock(o);
      expect((o.result?.limitations ?? []).map((l) => l.code)).toContain("reviewed-side-context-from-working-tree");
    });
  });
});
