/**
 * Issue #58 ([C260] Task scope: a file named by a natural-language task is reported
 * outside-task-context — part of #5 / Jira S15P31A106-259).
 *
 * Pinned reproduction fixtures (F1, F1c, F2, N1–N3):
 * - F1: Task "Fix HTTPError message formatting", diff touches `isHTTPError` in the same file
 *       (`source/errors/HTTPError.ts`). Before #58 Fix B: `outside-task-context`, WARN. Since Fix B
 *       (H-91): the task seed `sym:source/errors/HTTPError.ts#HTTPError` puts its owner file in the
 *       review scope, so the edit is `in-task-context`, PASS. (Evaluated at `max_depth: 1` for a sibling
 *       export, and at the default `max_depth: 2` when the diff touches top-level lines outside
 *       `HTTPError` so `diffSeeds` produces `file:source/errors/HTTPError.ts`.) The task packet itself
 *       (code, `omittedCandidates`, budget) is unchanged.
 * - F1c: Same task, diff touches the `HTTPError` class body (`source/errors/HTTPError.ts`).
 *        Current `next` behavior: `in-task-context`, PASS.
 * - F2: Task "Update HTTPError.ts to add a status code", diff touches the `HTTPError` class body.
 *       Current `next` behavior (H-79): basename with extension without a path separator does not
 *       resolve to a non-root file seed (`source/errors/HTTPError.ts` is not an exact path seed).
 *       Asserts the seed resolution and claim reason only, not the BM25-dependent verdict.
 * - N1: Same task as F1, diff touches unrelated `src/billing/invoice.ts`.
 *       Current `next` behavior: `outside-task-context`, WARN (must stay WARN under Fix B).
 * - N2: Same task as F1, diff touches an unrelated function in `src/client.ts`, which only imports
 *       `HTTPError`. `outside-task-context`, also under Fix B: `createError` is in the task packet as a
 *       CALLS neighbour, but only the owner files of task seeds join the scope (H-91 (2)).
 * - N3: No task provided. Current `next` behavior: no `scope-relevance` claims (`no-task-scope`
 *       limitation).
 *
 * Maintenance rule for pinned tests:
 * - Passing tests in this file pin current `next` behavior without
 *   altering PASS/WARN/BLOCK/ASK semantics or exit codes.
 * - A future fix PR (after a recorded Maintainer Decision such as draft H-91 for Fix B or a revision
 *   of H-79 for Fix A) must update the corresponding pinned assertion to the new expected value and
 *   convert the matching `it.todo` in this file into an active test in the same PR.
 * - Any change that alters review verdicts (`PASS` / `WARN` / `BLOCK` / `ASK`) must link a recorded
 *   Maintainer Decision.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileContext } from "../context/compile.js";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import type { ContextResult } from "../context/types.js";
import { reviewChanges } from "./review.js";
import type { ReviewClaim, ReviewRequest, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const W = { from: "HEAD" as const, to: "WORKTREE" as const };

const TASK_F1 = "Fix HTTPError message formatting";
const TASK_F2 = "Update HTTPError.ts to add a status code";

const PROJECT_YAML_DEPTH_1 = "schema_version: 1\nname: c260-task-scope-fixture\ncontext:\n  max_depth: 1\n";
const PROJECT_YAML_DEFAULT_DEPTH = "schema_version: 1\nname: c260-task-scope-fixture\n";

const FILES: Record<string, string> = {
  "package.json": '{ "name": "c260-task-scope-fixture", "type": "module" }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "allowJs": true, "strict": true } }\n',
  ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
  ".duo-project/project.yaml": PROJECT_YAML_DEPTH_1,
  "source/errors/HTTPError.ts": [
    "export class HTTPError extends Error {",
    "  readonly statusCode: number;",
    "",
    "  constructor(statusCode: number, message = \"Request failed\") {",
    "    super(`HTTP ${statusCode}: ${message}`);",
    "    this.name = \"HTTPError\";",
    "    this.statusCode = statusCode;",
    "  }",
    "}",
    "",
    "export function isHTTPError(error: unknown): error is HTTPError {",
    "  return error instanceof HTTPError;",
    "}",
    "",
  ].join("\n"),
  "src/client.ts": [
    'import { HTTPError } from "../source/errors/HTTPError.js";',
    "",
    "export function createError(status: number): HTTPError {",
    "  return new HTTPError(status);",
    "}",
    "",
    "export function parseRetryAfter(header: string | undefined): number {",
    "  const seconds = Number(header ?? 0);",
    "  return Number.isFinite(seconds) ? seconds : 0;",
    "}",
    "",
  ].join("\n"),
  "src/billing/invoice.ts": [
    "export function formatInvoiceTotal(cents: number): string {",
    '  return `$${(cents / 100).toFixed(2)}`;',
    "}",
    "",
  ].join("\n"),
};

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-c260-fixture-")));
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

async function runContext(r: ContextRepo, task: string): Promise<ContextResult> {
  await r.index();
  return withGraph(r.root, async (graph) => {
    const out = await compileContext(r.root, { task }, { graph, registry, historyWindow: HISTORY });
    if (out.value === undefined) throw new Error(JSON.stringify(out.diagnostics));
    return out.value;
  });
}

const scopeClaims = (res: ReviewResult): ReviewClaim[] =>
  res.claims.filter((c) => c.rule === "scope-relevance");

describe("Issue #58 ([C260]): task-scope relevance pinned fixtures (F1, F1c, F2, N1–N3)", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, fixture);
    await repo.index();
  });

  function reset(): void {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
  }

  it("F1 (#58 Fix B, H-91): the owner file of the task seed HTTPError is in task scope, so editing sibling export isHTTPError or file-level lines in the same file is in-task-context, PASS", async () => {
    reset();
    repo.edit(
      "source/errors/HTTPError.ts",
      "  return error instanceof HTTPError;",
      '  return error instanceof HTTPError && error.name === "HTTPError";',
    );

    const ctx = await runContext(repo, TASK_F1);
    expect(ctx.status).toBe("ready");
    expect(ctx.packet?.seeds).toContainEqual(
      expect.objectContaining({
        id: "sym:source/errors/HTTPError.ts#HTTPError",
        match: "symbol",
        term: "HTTPError",
      }),
    );
    // The task packet is unchanged by Fix B (H-91 (3)): it selects `HTTPError`, its constructor and the
    // CALLS neighbour `createError`; `dedupeContainers` still removes `file:source/errors/HTTPError.ts`,
    // `isHTTPError` is not in it, nothing is omitted and the budget is the default.
    expect(ctx.packet?.code.map((c) => c.id)).toEqual([
      "sym:source/errors/HTTPError.ts#HTTPError",
      "sym:src/client.ts#createError",
      "sym:source/errors/HTTPError.ts#HTTPError.constructor",
    ]);
    expect(ctx.packet?.omittedCandidates).toEqual([]);
    expect(ctx.packet?.metrics).toMatchObject({ budget: { total: 6000 }, candidates: 3, selected: 3, omitted: 0 });

    const res = await runReview(repo, { task: TASK_F1, diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual([
      "source/errors/HTTPError.ts#isHTTPError hunk-overlap",
    ]);
    const claims = scopeClaims(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      rule: "scope-relevance",
      subject: { kind: "file", id: "source/errors/HTTPError.ts" },
      alignment: "ALIGNED",
      reason: "in-task-context",
      drift: false,
    });
    expect(res.verdict).toBe("PASS");

    // Also at default `max_depth: 2` when the diff touches top-level lines outside any symbol range
    // (such as imports or module-level comments): `diffSeeds` produces `file:source/errors/HTTPError.ts`
    // (`file-changed`), which is now the seed's owner file in scope.
    reset();
    repo.write(".duo-project/project.yaml", PROJECT_YAML_DEFAULT_DEPTH);
    repo.git("commit", "-qam", "use default max_depth: 2");
    try {
      repo.write(
        "source/errors/HTTPError.ts",
        `// Format HTTP error message\n${FILES["source/errors/HTTPError.ts"] ?? ""}`,
      );
      const resDefaultDepth = await runReview(repo, { task: TASK_F1, diff: W });
      expect(resDefaultDepth.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual([
        "source/errors/HTTPError.ts file-changed",
      ]);
      expect(scopeClaims(resDefaultDepth)).toEqual([
        expect.objectContaining({
          rule: "scope-relevance",
          subject: { kind: "file", id: "source/errors/HTTPError.ts" },
          alignment: "ALIGNED",
          reason: "in-task-context",
          drift: false,
        }),
      ]);
      expect(resDefaultDepth.verdict).toBe("PASS");
    } finally {
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("F1c: pins current next behavior (in-task-context, PASS when task names HTTPError and diff edits the HTTPError class body)", async () => {
    reset();
    repo.edit(
      "source/errors/HTTPError.ts",
      "    super(`HTTP ${statusCode}: ${message}`);",
      "    super(`[HTTP ${statusCode}] ${message}`);",
    );

    const res = await runReview(repo, { task: TASK_F1, diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual([
      "source/errors/HTTPError.ts#HTTPError.constructor hunk-overlap",
    ]);
    const claims = scopeClaims(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      rule: "scope-relevance",
      subject: { kind: "file", id: "source/errors/HTTPError.ts" },
      alignment: "ALIGNED",
      reason: "in-task-context",
      drift: false,
    });
    expect(res.verdict).toBe("PASS");
  });

  it("F2: pins current next behavior (basename with extension HTTPError.ts is not an exact path or symbol seed under H-79; assert seed and claim reason only)", async () => {
    reset();
    repo.edit(
      "source/errors/HTTPError.ts",
      "    super(`HTTP ${statusCode}: ${message}`);",
      "    super(`HTTP ${statusCode} (${message})`);",
    );

    const ctx = await runContext(repo, TASK_F2);
    expect(ctx.status).toBe("ready");
    const seeds = ctx.resolution?.seeds ?? [];
    // Under H-79, `HTTPError.ts` has no directory separator and is not a root file, and
    // `NAME_TOKEN` reads `HTTPError.ts` as a dotted qualified name matching 0 symbols.
    // Neither `file:source/errors/HTTPError.ts` nor `sym:source/errors/HTTPError.ts#HTTPError`
    // is resolved as an exact `path`, `symbol`, or `symbol-name` seed.
    expect(seeds.filter((s) => s.match === "path" || s.match === "symbol" || s.match === "symbol-name")).toEqual([]);
    expect(seeds.some((s) => s.id === "file:source/errors/HTTPError.ts" && s.match === "path")).toBe(false);

    const res = await runReview(repo, { task: TASK_F2, diff: W });
    expect(res.status).toBe("ready");
    const claims = scopeClaims(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.subject).toEqual({ kind: "file", id: "source/errors/HTTPError.ts" });
    expect(["in-task-context", "outside-task-context"]).toContain(claims[0]?.reason);
  });

  it("N1: pins current next behavior (unrelated src/billing/invoice.ts is outside-task-context, WARN and must stay WARN under Fix B)", async () => {
    reset();
    repo.edit(
      "src/billing/invoice.ts",
      '  return `$${(cents / 100).toFixed(2)}`;',
      '  return `USD ${(cents / 100).toFixed(2)}`;',
    );

    const res = await runReview(repo, { task: TASK_F1, diff: W });
    expect(res.status).toBe("ready");
    const claims = scopeClaims(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      rule: "scope-relevance",
      subject: { kind: "file", id: "src/billing/invoice.ts" },
      alignment: "UNKNOWN",
      reason: "outside-task-context",
      drift: true,
    });
    expect(res.verdict).toBe("WARN");
  });

  it("N2: pins current next behavior (editing unrelated function parseRetryAfter in src/client.ts, which only imports HTTPError, is outside-task-context and must not spread through imports)", async () => {
    reset();
    repo.edit(
      "src/client.ts",
      "  return Number.isFinite(seconds) ? seconds : 0;",
      "  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;",
    );

    const ctx = await runContext(repo, TASK_F1);
    // `createError` (same file) is in the packet through CALLS; its owner file must not join the scope.
    expect(ctx.packet?.code.map((c) => c.id)).toContain("sym:src/client.ts#createError");
    expect(ctx.packet?.code.map((c) => c.id)).not.toContain("sym:src/client.ts#parseRetryAfter");

    const res = await runReview(repo, { task: TASK_F1, diff: W });
    expect(res.status).toBe("ready");
    expect(res.seeds.map((s) => `${s.ref} ${s.reason}`)).toEqual([
      "src/client.ts#parseRetryAfter hunk-overlap",
    ]);
    const claims = scopeClaims(res);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      rule: "scope-relevance",
      subject: { kind: "file", id: "src/client.ts" },
      alignment: "UNKNOWN",
      reason: "outside-task-context",
      drift: true,
    });
    expect(res.verdict).toBe("WARN");

    // Also verify at default `max_depth: 2`: `sym:src/client.ts#createError` is in the packet via
    // `CALLS`, which causes `dedupeContainers` to drop `file:src/client.ts`. Editing `parseRetryAfter`
    // stays `outside-task-context` today, whereas naive file-level expansion from any selected symbol
    // would mark `file:src/client.ts` in-scope if `src/client.ts` contains a caller of `HTTPError`.
    reset();
    repo.write(".duo-project/project.yaml", PROJECT_YAML_DEFAULT_DEPTH);
    repo.git("commit", "-qam", "use default max_depth: 2");
    try {
      repo.edit(
        "src/client.ts",
        "  return Number.isFinite(seconds) ? seconds : 0;",
        "  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;",
      );
      const ctxDefaultDepth = await runContext(repo, TASK_F1);
      expect(ctxDefaultDepth.status).toBe("ready");
      expect(ctxDefaultDepth.packet?.code.map((c) => c.id)).toContain("sym:src/client.ts#createError");
      expect(ctxDefaultDepth.packet?.code.map((c) => c.id)).not.toContain("file:src/client.ts");
      expect(ctxDefaultDepth.packet?.code.map((c) => c.id)).not.toContain("sym:src/client.ts#parseRetryAfter");

      const resDefaultDepth = await runReview(repo, { task: TASK_F1, diff: W });
      expect(scopeClaims(resDefaultDepth)).toEqual([
        expect.objectContaining({
          rule: "scope-relevance",
          subject: { kind: "file", id: "src/client.ts" },
          alignment: "UNKNOWN",
          reason: "outside-task-context",
          drift: true,
        }),
      ]);
      expect(resDefaultDepth.verdict).toBe("WARN");
    } finally {
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("N3: pins current next behavior (no task emits no scope-relevance claims and records no-task-scope limitation)", async () => {
    reset();
    repo.edit(
      "source/errors/HTTPError.ts",
      "  return error instanceof HTTPError;",
      '  return error instanceof HTTPError && error.name === "HTTPError";',
    );

    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    expect(scopeClaims(res)).toEqual([]);
    expect(res.limitations.map((l) => l.code)).toContain("no-task-scope");
    expect(res.verdict).toBe("PASS");
  });
});
