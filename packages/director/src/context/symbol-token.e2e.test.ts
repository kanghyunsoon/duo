/**
 * C251 (T50): a task token that resolved to an exact Symbol seed (a unique qualified name, a unique simple name, or one
 * callable group) is not reused as BM25 keyword input, as C249 (T46) did for exact paths. Only that token is withdrawn:
 * the other words, unresolved names and ambiguous names keep their behavior. Fixture: Session.open next to an audit
 * subsystem whose name shares its words (openSessionAudit, governed by D-003).
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
  w("package.json", JSON.stringify({ name: "c251", version: "1.0.0", type: "module" }) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }) + "\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: c251\n");
  w(".duo-project/specs/tasks.md", ["# Tasks", "", "## TASK-015 Desktop packaging", "", "```duo", "type: issue", "status: todo", "```", "", "Package the desktop app.", ""].join("\n"));
  w(".duo-project/decisions/D-001.yaml", decision("D-001", "Sessions use opaque tokens", "opaque server-side tokens", ["src/auth/**"]));
  w(".duo-project/decisions/D-002.yaml", decision("D-002", "Charges are idempotent", "idempotency keys", ["src/payment/**"]));
  w(".duo-project/decisions/D-003.yaml", decision("D-003", "Audit trail is append-only", "audit records are never rewritten", ["src/audit/**"]));
  w(".duo-project/decisions/D-004.yaml", decision("D-004", "Network calls are throttled", "a shared limiter", ["src/net/**"]));
  w("src/auth/session.ts", "export class Session {\n  open(user: string): string {\n    return user;\n  }\n}\n");
  w("src/auth/token.ts", "export const token = (s: string): string => s;\n");
  w("src/payment/charge.ts", "export function charge(n: number): number {\n  return n;\n}\n");
  w("src/payment/retry.ts", "export function retryCharge(n: number): number {\n  return n;\n}\n");
  w("src/audit/open-session-audit.ts", "export function openSessionAudit(id: string): string {\n  return id;\n}\n");
  w("src/net/rate-limiter.ts", "export class RateLimiter {\n  allow(): boolean {\n    return true;\n  }\n}\n");
  w("src/a/service.ts", "export class Service {\n  open(): number {\n    return 1;\n  }\n}\n");
  w("src/b/service.ts", "export class Service {\n  open(): number {\n    return 2;\n  }\n}\n");
}

const seeds = (r: ContextResult) => r.packet?.seeds.map((s) => `${s.ref}/${s.match}`) ?? [];
const keywordSeeds = (r: ContextResult) => r.packet?.seeds.filter((s) => s.match === "keyword").map((s) => s.ref) ?? [];
const active = (r: ContextResult) => r.packet?.decisions.active.map((d) => d.ref) ?? [];

describe("keywordQueryTokens (C249, C251)", () => {
  it("drops ID tokens and tokens consumed by an exact path or Symbol seed, keeps every other word in order", () => {
    const tokens = ["TASK-015", "Modify", "Session.open", "src/auth/session.ts", "payment", "MissingService.run", "retry"];
    expect(keywordQueryTokens(tokens, new Set(["TASK-015"]), new Set(["src/auth/session.ts", "Session.open"]))).toEqual(["Modify", "payment", "MissingService.run", "retry"]);
  });
});

describe("exact Symbol tokens are not BM25 input (C251, T50)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-c251-"));
    temps.push(fixture);
    writeFixture(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    const s = createDecisionService({ root: repo.root, clock: () => new Date("2026-10-09T00:00:00Z") });
    for (const id of ["D-001", "D-002", "D-003", "D-004"]) expect((await s.confirm({ kind: "human", name: "Ada" }, id)).value?.decisionId).toBe(id);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "decisions");
    await repo.index();
  });
  afterAll(() => registry?.dispose());

  it("1 a unique qualified name: only its Symbol seed; D-001 through the Symbol's File; the audit subsystem and D-003 stay out", async () => {
    for (const task of ["Session.open", "Session.open()"]) {
      const r = await repo.compile({ task, budget: 6000 });
      expect(seeds(r), task).toEqual(["src/auth/session.ts#Session.open/symbol"]);
      expect(active(r), task).toEqual(["D-001"]);
      expect(r.packet?.code.some((c) => c.ref.startsWith("src/audit/")), task).toBe(false);
      expect(r.packet?.metrics.budget.used, task).toBeLessThanOrEqual(6000);
    }
  });

  it("2 a unique simple name (symbol-name) and a top-level name (symbol) are consumed the same way", async () => {
    expect(seeds(await repo.compile({ task: "RateLimiter", budget: 6000 }))).toEqual(["src/net/rate-limiter.ts#RateLimiter/symbol"]);
    const allow = await repo.compile({ task: "Modify allow payment", budget: 6000 });
    expect(allow.packet?.seeds.filter((s) => s.match !== "keyword").map((s) => `${s.ref}/${s.match}`)).toEqual(["src/net/rate-limiter.ts#RateLimiter.allow/symbol-name"]);
    expect(keywordSeeds(allow).every((s) => s.startsWith("src/payment/"))).toBe(true);
    expect(active(allow).sort()).toEqual(["D-002", "D-004"]);
  });

  it("3 the user's other words stay keyword input: payment retry still finds the payment files", async () => {
    const r = await repo.compile({ task: "Modify Session.open payment retry", budget: 6000 });
    expect(seeds(r)[0]).toBe("src/auth/session.ts#Session.open/symbol");
    expect(keywordSeeds(r)).toContain("src/payment/retry.ts");
    expect(keywordSeeds(r).some((s) => /^src\/(auth|audit|a|b)\//u.test(s))).toBe(false);
    expect(active(r).sort()).toEqual(["D-001", "D-002"]);
  });

  it("4 an unresolved name-like token keeps the keyword fallback", async () => {
    const r = await repo.compile({ task: "MissingService.run", budget: 6000 });
    expect(r.status).toBe("ready");
    expect(r.packet?.seeds.every((s) => s.match === "keyword")).toBe(true);
    expect(keywordSeeds(r)).toEqual(expect.arrayContaining(["src/a/service.ts#Service", "src/b/service.ts#Service"]));
  });

  it("5 an ambiguous qualified name is not consumed: alone it asks; next to an exact path it stays keyword input", async () => {
    const alone = await repo.compile({ task: "Service.open", budget: 6000 });
    expect(alone.status).toBe("ambiguous");
    expect(alone.resolution?.ambiguities.map((a) => `${a.term}:${a.reason}`)).toEqual(["Service.open:qualified-name"]);
    const withPath = await repo.compile({ task: "src/auth/session.ts Service.open", budget: 6000 });
    expect(withPath.status).toBe("ready");
    expect(seeds(withPath)[0]).toBe("src/auth/session.ts/path");
    expect(keywordSeeds(withPath)).toEqual(expect.arrayContaining(["src/a/service.ts#Service.open", "src/b/service.ts#Service.open"]));
  });

  it("7 an ID with a Symbol: both exact, no words of the Symbol in BM25", async () => {
    const r = await repo.compile({ task: "TASK-015 Session.open", budget: 6000 });
    expect(seeds(r)).toEqual(["TASK-015/id", "src/auth/session.ts#Session.open/symbol"]);
    expect(active(r)).toEqual(["D-001"]);
  });

  it("8-9 exact paths keep C249 and C252; a path with a Symbol gives only the two exact seeds", async () => {
    for (const task of ["src/auth/session.ts", "./src/auth/session.ts", "src\\auth\\session.ts"]) {
      const r = await repo.compile({ task, budget: 6000 });
      expect(seeds(r), task).toEqual(["src/auth/session.ts/path"]);
      expect(active(r), task).toEqual(["D-001"]);
    }
    const both = await repo.compile({ task: "src/auth/session.ts Session.open", budget: 6000 });
    expect(both.packet?.seeds.every((s) => s.match !== "keyword")).toBe(true);
  });

  it("10 a keyword-only task is unchanged", async () => {
    const r = await repo.compile({ task: "opaque server tokens", budget: 6000 });
    expect(seeds(r)).toEqual(["D-001/keyword"]);
  });

  it("cache: policy 6 packets miss first, then hit with the same bytes", async () => {
    const a = await repo.compile({ task: "Session.open", budget: 6000 }, { cache: true });
    const b = await repo.compile({ task: "Session.open", budget: 6000 }, { cache: true });
    expect(a.cache.status).toBe("miss");
    expect(b.cache.status).toBe("hit");
    expect(JSON.stringify(b.packet)).toBe(JSON.stringify(a.packet));
  });
});
