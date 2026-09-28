import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, INIT_FIXTURE, makeContextRepo, REVIEW_FIXTURE, type ContextRepo } from "../context/testing.js";
import { applyInitPlan } from "../init/apply.js";
import { planInit } from "../init/plan.js";
import { reviewChanges } from "../review/review.js";
import type { ReviewResult } from "../review/types.js";
import { captureAdoptionBaseline, getAdoptionBaselineStatus, loadAdoptionBaseline, type CaptureBaselineOptions } from "./baseline.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await contextRegistry(); });
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const human = { kind: "human" as const, name: "Ada" };
const clock = () => new Date("2026-09-28T00:00:00.000Z");
const W = { from: "HEAD" as const, to: "WORKTREE" as const };

async function withGraph<T>(root: string, fn: (g: GraphStore) => Promise<T>): Promise<T> {
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try { return await fn(opened.value); } finally { opened.value.close(); }
}
const capture = (root: string, extra: Partial<CaptureBaselineOptions> = {}) =>
  withGraph(root, (graph) => captureAdoptionBaseline(root, { graph, registry, historyWindow: HISTORY, actor: human, clock, ...extra }));
async function review(root: string, task?: string): Promise<ReviewResult> {
  return withGraph(root, async (graph) => {
    const r = await reviewChanges(root, { ...(task === undefined ? {} : { task }), diff: W }, { graph, registry, historyWindow: HISTORY });
    if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
    return r.value.result;
  });
}
const adoptionFiles = (root: string) => {
  const dir = path.join(root, ".duo-project", "reviews");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("adoption-")) : [];
};
function snapshot(root: string): [string, string][] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => !f.split(path.sep).includes(".git")).sort()
    .map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f)).toString("base64") : "<dir>"]);
}

/** An existing repository, adopted by DUO: plan → apply → index. */
async function adopted(mutate?: (r: ContextRepo) => void): Promise<ContextRepo> {
  const repo = makeContextRepo(temps, registry, INIT_FIXTURE);
  mutate?.(repo);
  const plan = await planInit(repo.root);
  if (plan.value === undefined) throw new Error(JSON.stringify(plan.diagnostics));
  const applied = await applyInitPlan(repo.root, plan.value, [{ question: "project_goal", value: "Settle shared expenses." }]);
  if (applied.value === undefined) throw new Error(JSON.stringify(applied.diagnostics));
  await repo.index();
  return repo;
}

describe("Adoption Baseline (T14.1)", () => {
  it("a clean repository: captured after the index, recorded under reviews/, deterministic on recapture", async () => {
    const repo = await adopted();
    expect(adoptionFiles(repo.root)).toEqual([]); // init itself never captures
    const r = await capture(repo.root);
    expect(r.value).toMatchObject({ status: "captured", path: expect.stringMatching(/^\.duo-project\/reviews\/adoption-[0-9a-f]{16}\.json$/u) });
    const b = r.value?.status === "aborted" ? undefined : r.value?.baseline;
    expect(b).toMatchObject({
      format: "duo.adoption-baseline/1", project: { name: "pocket-ledger" }, git: { branch: "main", detached: false, headOid: expect.stringMatching(/^[0-9a-f]{40}$/u) },
      truth: { digest: expect.stringMatching(/^sha256:/u) }, index: { stateToken: expect.stringMatching(/^sha256:/u) },
      workingTree: { dirty: false, policy: "HEAD_BASELINE", staged: [], unstaged: [], untracked: [] }, findings: [], limitations: [], recorded: { by: "Ada" },
    });
    const again = await capture(repo.root, { clock: () => new Date("2027-01-01T00:00:00Z"), actor: { kind: "human", name: "Grace" } });
    expect(again.value).toMatchObject({ status: "unchanged", id: r.value?.status === "aborted" ? "" : r.value?.id });
    expect(adoptionFiles(repo.root)).toHaveLength(1);
    expect((await getAdoptionBaselineStatus(repo.root)).value?.status).toBe("current");
    // Recording the baseline does not make the index stale (reviews/ is not indexed).
    expect((await review(repo.root)).status).toBe("ready");
  });

  it("refuses a stale index, an agent, and a second, different baseline", async () => {
    const repo = await adopted();
    repo.edit("src/settle.ts", "Math.floor", "Math.round");
    expect((await capture(repo.root)).diagnostics.map((d) => d.code)).toEqual(["ADOPTION_INDEX_REQUIRED"]);
    expect(adoptionFiles(repo.root)).toEqual([]);
    repo.git("checkout", "--", "src/settle.ts");
    expect((await capture(repo.root, { actor: { kind: "agent", name: "codex" } })).diagnostics.map((d) => d.code)).toEqual(["ADOPTION_FORBIDDEN"]);
    expect((await capture(repo.root)).value?.status).toBe("captured");
    repo.edit("src/settle.ts", "Math.floor", "Math.round");
    repo.git("commit", "-qam", "later work");
    await repo.index();
    expect((await capture(repo.root)).diagnostics.map((d) => d.code)).toEqual(["ADOPTION_BASELINE_EXISTS"]);
    expect((await getAdoptionBaselineStatus(repo.root)).value?.status).toBe("advanced");
  });

  it("a dirty working tree is detected at planning; no policy is refused, ABORT_AND_CLEAN writes nothing, HEAD_BASELINE records it", async () => {
    const dirty = (r: ContextRepo) => { r.edit("src/ledger.ts", "return [...ledger, expense];", "return ledger.concat([expense]);"); r.write("src/currency.ts", "export const EUR = \"EUR\";\n"); };
    const repo = makeContextRepo(temps, registry, INIT_FIXTURE);
    dirty(repo);
    const plan = await planInit(repo.root);
    expect(plan.value?.observed.workingTree).toMatchObject({ workingTreeDirty: true, dirty: true, unstaged: ["src/ledger.ts"], untracked: ["src/currency.ts"], counts: { staged: 0, unstaged: 1, untracked: 1 } });
    expect(plan.value?.applicable).toBe(true); // dirty is not an init failure

    const repo2 = await adopted(dirty);
    expect((await capture(repo2.root)).diagnostics.map((d) => d.code)).toEqual(["ADOPTION_DIRTY_POLICY_REQUIRED"]);
    expect((await capture(repo2.root, { policy: "ABORT_AND_CLEAN" })).value).toMatchObject({ status: "aborted", reason: "dirty-working-tree" });
    expect(adoptionFiles(repo2.root)).toEqual([]);
    const r = await capture(repo2.root, { policy: "HEAD_BASELINE" });
    const b = r.value?.status === "captured" ? r.value.baseline : undefined;
    expect(b?.workingTree).toMatchObject({
      dirty: true, policy: "HEAD_BASELINE",
      unstaged: [{ path: "src/ledger.ts", contentHash: expect.stringMatching(/^sha256:/u) }], untracked: [{ path: "src/currency.ts", contentHash: expect.stringMatching(/^sha256:/u) }],
    });
    expect(b?.limitations).toContain("dirty-paths-not-baselined");
    expect(JSON.stringify(b)).not.toContain("ledger.concat"); // hashes, not content
    // The dirty changes are not hidden: they are still what the next Review looks at.
    expect((await review(repo2.root)).diff?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/currency.ts", "src/ledger.ts"]));
  });
});

const LEGACY = "/** Kept from before DUO. */\nexport class LegacySessionStore {\n  private readonly sessions = new Map<string, string>();\n\n  save(token: string, userId: string): void {\n    this.sessions.set(token, userId);\n  }\n}\n";
const SERVER = "export class ServerSessionStore {\n  keep(token: string): string {\n    return token;\n  }\n}\n";

describe("pre-existing vs introduced violations (T14.1)", () => {
  let repo: ContextRepo;
  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, REVIEW_FIXTURE);
    repo.write("src/auth/legacy-session-store.ts", LEGACY);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "legacy store");
    await repo.index();
  });
  const reset = async () => { repo.git("reset", "-q", "--hard"); repo.git("clean", "-fdq", "-e", ".duo-project/reviews"); };

  it("a legacy DUO project without a baseline is missing; reading writes nothing and Review has no provenance", async () => {
    const before = snapshot(repo.root);
    expect((await getAdoptionBaselineStatus(repo.root)).value?.status).toBe("missing");
    expect(loadAdoptionBaseline(repo.root).status).toBe("missing");
    expect(snapshot(repo.root)).toEqual(before);
    repo.edit("src/auth/legacy-session-store.ts", "this.sessions.set(token, userId);", "this.sessions.set(token, userId.trim());");
    await repo.index();
    const res = await review(repo.root);
    expect(res.baseline).toEqual({ status: "missing" });
    const c = res.claims.find((x) => x.rule === "decision-forbids");
    expect(c).toMatchObject({ blockEligible: true, violationKey: expect.stringMatching(/^vk-/u) });
    expect(c?.provenance).toBeUndefined();
    expect(res.verdict).toBe("BLOCK");
    await reset();
    await repo.index();
  });

  it("an existing forbidden symbol is a pre-existing baseline finding", async () => {
    const r = await capture(repo.root);
    const b = r.value?.status === "captured" ? r.value.baseline : undefined;
    expect(b?.findings.filter((f) => f.rule === "decision-forbids").map((f) => [f.governing, f.offending, f.enforced]).sort()).toEqual([
      ["D-004", "sym:src/auth/legacy-session-store.ts#LegacySessionStore", true],
      ["D-004", "sym:src/auth/legacy-session-store.ts#LegacySessionStore.save", true],
    ]);
    const before = snapshot(repo.root);
    expect((await getAdoptionBaselineStatus(repo.root)).value?.status).toBe("current");
    expect(snapshot(repo.root)).toEqual(before);
  });

  it("a new forbidden symbol is introduced: BLOCK", async () => {
    await reset();
    repo.write("src/auth/server-session-store.ts", SERVER);
    await repo.index();
    const res = await review(repo.root, "AUTH-03");
    expect(res.baseline.status).toBe("present");
    const c = res.claims.find((x) => x.rule === "decision-forbids");
    expect(c).toMatchObject({ provenance: "introduced", blockEligible: true, alignment: "CONFLICT" });
    expect(res.verdict).toBe("BLOCK");
  });

  it("changing the pre-existing forbidden symbol is pre-existing-touched: WARN, never BLOCK", async () => {
    await reset();
    repo.edit("src/auth/legacy-session-store.ts", "this.sessions.set(token, userId);", "this.sessions.set(token, userId.trim());");
    await repo.index();
    const res = await review(repo.root, "AUTH-03");
    const c = res.claims.find((x) => x.rule === "decision-forbids");
    expect(c).toMatchObject({ provenance: "pre-existing-touched", blockEligible: false, alignment: "CONFLICT", enforced: true });
    expect(res.verdict).toBe("WARN");
    expect(res.verdictBasis.warn).toContain(c?.id);
  });

  it("a tampered or duplicated baseline is incompatible and unusable for provenance", async () => {
    await reset();
    const file = adoptionFiles(repo.root)[0] ?? "";
    const abs = path.join(repo.root, ".duo-project", "reviews", file);
    const original = fs.readFileSync(abs, "utf8");
    fs.writeFileSync(abs, original.replace('"dirty": false', '"dirty": true'));
    expect((await getAdoptionBaselineStatus(repo.root)).value?.status).toBe("incompatible");
    repo.write("src/auth/server-session-store.ts", SERVER);
    await repo.index();
    const res = await review(repo.root, "AUTH-03");
    expect(res.baseline.status).toBe("incompatible");
    expect(res.limitations.map((l) => l.code)).toContain("adoption-baseline-unusable");
    expect(res.claims.find((x) => x.rule === "decision-forbids")?.provenance).toBeUndefined();
    fs.writeFileSync(abs, original);
  });
});
