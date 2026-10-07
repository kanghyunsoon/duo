/**
 * C249 (T46): a task token that resolved to an existing File as an exact path seed is not reused as BM25 keyword
 * input. Only that token is withdrawn: the other words of the task, IDs (already excluded) and path-like tokens that
 * matched no File keep their behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keywordQueryTokens } from "./seeds.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const decision = (id: string, title: string, answer: string, paths: string[]) =>
  `id: ${id}\ntitle: ${title}\nkind: decision\nstate: proposed\nquestion: ${id.toLowerCase()}_rule\nanswer: ${answer}\ngoverns:\n  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]\nenforcement: warn\n`;

function writeFixture(dir: string): void {
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w("package.json", JSON.stringify({ name: "c249", version: "1.0.0", type: "module" }) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }) + "\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: c249\n");
  w(".duo-project/specs/tasks.md", ["# Tasks", "", "## TASK-015 Desktop packaging", "", "```duo", "type: issue", "status: todo", "```", "", "Package the desktop app.", ""].join("\n"));
  w(".duo-project/decisions/D-001.yaml", decision("D-001", "Sessions use opaque tokens", "opaque server-side tokens", ["src/auth/**"]));
  w(".duo-project/decisions/D-002.yaml", decision("D-002", "Charges are idempotent", "idempotency keys", ["src/payment/**"]));
  w("src/auth/session.ts", "export class Session {\n  open(user: string): string {\n    return user;\n  }\n}\n");
  w("src/auth/token.ts", "export const token = (s: string): string => s;\n");
  w("src/payment/charge.ts", "export function charge(n: number): number {\n  return n;\n}\n");
  w("src/payment/retry.ts", "export function retryCharge(n: number): number {\n  return n;\n}\n");
}

const seeds = (r: ContextResult) => r.packet?.seeds.map((s) => `${s.ref}/${s.match}`) ?? [];
const keywordSeeds = (r: ContextResult) => r.packet?.seeds.filter((s) => s.match === "keyword").map((s) => s.ref) ?? [];
const active = (r: ContextResult) => r.packet?.decisions.active.map((d) => d.ref) ?? [];

describe("keywordQueryTokens (C249)", () => {
  it("drops ID tokens and tokens that resolved to an exact path, keeps every other word in order", () => {
    const tokens = ["TASK-015", "Modify", "src/auth/session.ts", "payment", "src/auth/session.ts", "src/unknown/x.ts", "retry"];
    expect(keywordQueryTokens(tokens, new Set(["TASK-015"]), new Set(["src/auth/session.ts"]))).toEqual(["Modify", "payment", "src/unknown/x.ts", "retry"]);
    expect(keywordQueryTokens(["refresh", "token", "rotation"], new Set(), new Set())).toEqual(["refresh", "token", "rotation"]);
  });
});

describe("exact path tokens are not BM25 input (C249, T46)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-c249-"));
    temps.push(fixture);
    writeFixture(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    const s = createDecisionService({ root: repo.root, clock: () => new Date("2026-10-08T00:00:00Z") });
    for (const id of ["D-001", "D-002"]) expect((await s.confirm({ kind: "human", name: "Ada" }, id)).value?.decisionId).toBe(id);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "decisions");
    await repo.index();
  });

  for (const task of ["src/auth/session.ts", "Modify src/auth/session.ts"]) {
    it(`1-2 "${task}": only the path seed; D-001 through GOVERNS, no payment file or D-002`, async () => {
      const r = await repo.compile({ task, budget: 6000 });
      expect(seeds(r)).toEqual(["src/auth/session.ts/path"]);
      expect(active(r)).toEqual(["D-001"]);
      expect(r.packet?.decisions.active[0]?.via?.steps.map((s) => `${s.from} ${s.type} ${s.to}`)).toEqual(["D-001 GOVERNS src/auth/session.ts"]);
      expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(6000);
    });
  }

  it("3 the user's own words stay keyword input: payment retry finds the payment files", async () => {
    const r = await repo.compile({ task: "Modify src/auth/session.ts payment retry", budget: 6000 });
    expect(seeds(r)[0]).toBe("src/auth/session.ts/path");
    expect(keywordSeeds(r)).toContain("src/payment/retry.ts");
    expect(keywordSeeds(r).some((s) => s.startsWith("src/auth/"))).toBe(false);
    expect(active(r)).toEqual(expect.arrayContaining(["D-001", "D-002"]));
  });

  it("4-5 two exact paths are both consumed; a repeated path gives the same result", async () => {
    const two = await repo.compile({ task: "Modify src/auth/session.ts src/auth/token.ts", budget: 6000 });
    expect(seeds(two)).toEqual(["src/auth/session.ts/path", "src/auth/token.ts/path"]);
    expect(active(two)).toEqual(["D-001"]);
    const once = await repo.compile({ task: "Modify src/auth/session.ts", budget: 6000 });
    const twice = await repo.compile({ task: "Modify src/auth/session.ts src/auth/session.ts", budget: 6000 });
    expect(seeds(twice)).toEqual(seeds(once));
    expect(active(twice)).toEqual(active(once));
  });

  it("6 a path-like token that matches no File keeps the keyword behavior (also ./ and backslash forms, which are not exact today)", async () => {
    for (const task of ["Modify src/auth/sessions.ts", "./src/auth/session.ts", "src\\auth\\session.ts"]) {
      const r = await repo.compile({ task, budget: 6000 });
      expect(r.packet?.seeds.some((s) => s.match === "path"), task).toBe(false);
      expect(keywordSeeds(r).length, task).toBeGreaterThan(0);
    }
  });

  it("7-8 an ID with a path: both exact, no path words; an ID with words: the words stay", async () => {
    const withPath = await repo.compile({ task: "TASK-015 src/auth/session.ts", budget: 6000 });
    // Equal strength: ordered by node ID (file: before issue:).
    expect(seeds(withPath)).toEqual(["src/auth/session.ts/path", "TASK-015/id"]);
    const withWords = await repo.compile({ task: "TASK-015 payment retry", budget: 6000 });
    expect(seeds(withWords)).toContain("TASK-015/id");
    expect(keywordSeeds(withWords)).toContain("src/payment/retry.ts");
    const issue = withWords.packet?.issues.find((i) => i.ref === "TASK-015");
    expect(issue?.level).toBe("L3");
  });

  it("9 a keyword-only task is unchanged: no exact seed, keyword seeds as before", async () => {
    const r = await repo.compile({ task: "opaque server tokens", budget: 6000 });
    expect(r.packet?.seeds.every((s) => s.match === "keyword")).toBe(true);
    expect(keywordSeeds(r)).toContain("D-001");
  });
it("cache: policy 4 packets miss first, then hit with the same bytes", async () => {
    const a = await repo.compile({ task: "Modify src/auth/session.ts", budget: 6000 }, { cache: true });
    const b = await repo.compile({ task: "Modify src/auth/session.ts", budget: 6000 }, { cache: true });
    expect(a.cache.status).toBe("miss");
    expect(b.cache.status).toBe("hit");
    expect(JSON.stringify(b.packet)).toBe(JSON.stringify(a.packet));
  });
});
