/**
 * Issue #7 (Editing README after setup makes every review WARN — Jira S15P31A106-261, part of #5).
 *
 * Fixture: the T71 audit README (`docs/roadmap/0.3.2-t71-readme-provenance-audit.md` §2), set up
 * through the real init path (`planInit` + `applyInitPlan` accepting the README suggestion). Init
 * records `source: [{ path: README.md, hash }]` on `.duo-project/intent/vision.md`: the whole file,
 * no section, no excerpt.
 *
 * Pinned reproduction fixtures (A, B, C1–C3, N1, R1, S1):
 * - A: The adopted sentence itself changes. Current `next` behavior: `external-source-changed`,
 *      PARTIAL, WARN. A real change to the adopted goal; must keep a visible signal under any policy.
 * - B: Another paragraph (`## Usage`) changes. Current `next` behavior: WARN, the same claim as A.
 * - C1: A one-letter typo in another paragraph. Current `next` behavior: WARN.
 * - C2: Trailing spaces only. Current `next` behavior: WARN.
 * - C3: Line endings only (LF → CRLF). Current `next` behavior: `external-source-unchanged`, ALIGNED,
 *       PASS (canonical text).
 * - N1: A code-only change with the README untouched. Current `next` behavior: no drift claim, PASS.
 * - R1: The B edit plus the vision `hash` replaced by the observed value (the undocumented manual
 *       recovery in T71 §5). Current `next` behavior: ALIGNED, PASS.
 * - S1: The vision source names the README's H1 section (`section: demo`) and the B edit is made.
 *       Current `next` behavior: still WARN, because an H1 section runs to the next H1 or the end of
 *       the file (T71 §3), so the existing `section` field does not separate A from B here.
 *
 * Maintenance rule for pinned tests:
 * - Passing tests in this file pin current `next` behavior without altering PASS/WARN/BLOCK/ASK
 *   semantics or exit codes (H-85: ADR-014 / H-16 provenance and R-DRIFT PARTIAL are kept until a new
 *   Human Decision).
 * - A future fix PR (after the 0.4 README drift policy is recorded as a Maintainer Decision, Jira
 *   S15P31A106-261) must update the corresponding pinned assertion to the new expected value and
 *   convert the matching `it.todo` in this file into an active test in the same PR.
 * - Whatever the policy, the fact that the confirmed source changed must stay visible (#5 non-goal:
 *   no hidden facts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { externalSourceSlice, loadProjectTruth } from "@duo-director/core";
import { openProjectGraphStore, type GraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { applyInitPlan } from "../init/apply.js";
import { planInit } from "../init/plan.js";
import { reviewChanges } from "./review.js";
import type { ReviewClaim, ReviewRequest, ReviewResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let fixture: string;
const W = { from: "HEAD" as const, to: "WORKTREE" as const };

const VISION = ".duo-project/intent/vision.md";
const README = "# demo\n\nA tiny demo project for testing DUO.\n\n## Usage\n\nRun the demo with node.\n\n## License\n\nMIT\n";
const ADOPTED = "A tiny demo project for testing DUO.";
const FILES: Record<string, string> = {
  "package.json": '{ "name": "demo", "type": "module" }\n',
  "README.md": README,
  "src/index.ts": "export function main(): string {\n  return \"demo\";\n}\n",
};

const sliceHash = (text: string, section?: string): string => {
  const slice = externalSourceSlice("README.md", text, section);
  if (slice.status !== "ok") throw new Error(slice.status);
  return slice.hash;
};
const RECORDED = sliceHash(README);

beforeAll(async () => {
  registry = await contextRegistry();
  fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-i7-fixture-")));
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

const driftClaims = (res: ReviewResult): ReviewClaim[] => res.claims.filter((c) => c.rule === "external-source-drift");
const claimIds = (claims: readonly ReviewClaim[]): string[] => claims.map((c) => c.id).sort();

describe("Issue #7: README external-source-drift pinned fixtures (A, B, C1–C3, N1, R1, S1)", () => {
  let repo: ContextRepo;

  beforeAll(async () => {
    repo = makeContextRepo(temps, registry, fixture);
    const plan = await planInit(repo.root);
    if (plan.value === undefined) throw new Error(JSON.stringify(plan.diagnostics));
    const goal = plan.value.questions.find((q) => q.id === "project_goal");
    expect(goal?.suggestedValue).toBe(ADOPTED);
    const applied = await applyInitPlan(repo.root, plan.value, [{ question: "project_goal", value: ADOPTED, acceptSuggestion: true }]);
    if (applied.value === undefined) throw new Error(JSON.stringify(applied.diagnostics));
    repo.git("add", "-A");
    repo.git("commit", "-qm", "duoctl init");
    await repo.index();
  });

  function reset(): void {
    repo.git("reset", "-q", "--hard");
    repo.git("clean", "-fdq");
  }

  /** The one drift claim on the vision, and the verdict basis is exactly that claim when it warns. */
  async function reviewDrift(): Promise<{ res: ReviewResult; claim: ReviewClaim | undefined }> {
    const res = await runReview(repo, { diff: W });
    expect(res.status).toBe("ready");
    const claims = driftClaims(res);
    expect(claims.length).toBeLessThanOrEqual(1);
    return { res, claim: claims[0] };
  }

  function expectChanged(res: ReviewResult, claim: ReviewClaim | undefined, observedHash: string, where = "README.md"): void {
    expect(claim).toMatchObject({
      rule: "external-source-drift",
      subject: { kind: "vision", id: VISION },
      alignment: "PARTIAL",
      reason: "external-source-changed",
      blockEligible: false,
      expected: `${where} has hash ${RECORDED} as confirmed for ${VISION}`,
      observed: `${where} now has hash ${observedHash} (the confirmed Truth is not changed; a human decides)`,
    });
    expect(res.verdictBasis).toEqual({ blocking: [], ask: [], warn: claimIds(driftClaims(res)) });
    expect(res.verdict).toBe("WARN");
  }

  it("init records the whole README as the vision source (no section, no excerpt)", () => {
    expect(loadProjectTruth(repo.root).value?.truth.vision).toMatchObject({
      status: "confirmed",
      sources: [{ kind: "external", path: "README.md", hash: RECORDED }],
    });
    expect(repo.read(VISION)).not.toContain("section:");
  });

  it("A: pins current next behavior (the adopted sentence changes: external-source-changed, PARTIAL, WARN; must keep a visible signal)", async () => {
    reset();
    repo.edit("README.md", "for testing DUO.", "for testing DUO and friends.");
    const { res, claim } = await reviewDrift();
    expectChanged(res, claim, sliceHash(repo.read("README.md")));
  });

  it("B: pins current next behavior (another paragraph changes: the same WARN as A)", async () => {
    reset();
    repo.edit("README.md", "Run the demo with node.", "Run the demo with Node.js 24 or newer.");
    const { res, claim } = await reviewDrift();
    expectChanged(res, claim, sliceHash(repo.read("README.md")));
  });

  it("C1: pins current next behavior (a one-letter typo in another paragraph: WARN)", async () => {
    reset();
    repo.edit("README.md", "with node.", "with Node.");
    const { res, claim } = await reviewDrift();
    expectChanged(res, claim, sliceHash(repo.read("README.md")));
  });

  it("C2: pins current next behavior (trailing spaces only: WARN)", async () => {
    reset();
    repo.edit("README.md", "MIT\n", "MIT  \n");
    const { res, claim } = await reviewDrift();
    expectChanged(res, claim, sliceHash(repo.read("README.md")));
  });

  it.todo(
    "B / C1 / C2 follow-up (#7, needs the 0.4 README drift policy recorded as a Maintainer Decision, Jira S15P31A106-261): a README edit that leaves the adopted text unchanged does not produce an attention-demanding WARN, while the source change stays visible",
  );

  it("C3: pins current next behavior (line endings only, LF → CRLF: external-source-unchanged, ALIGNED, PASS)", async () => {
    reset();
    repo.write("README.md", README.replace(/\n/gu, "\r\n"));
    const { res, claim } = await reviewDrift();
    expect(claim).toMatchObject({ subject: { kind: "vision", id: VISION }, alignment: "ALIGNED", reason: "external-source-unchanged" });
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it("N1: pins current next behavior (a code-only change with the README untouched: no drift claim, PASS)", async () => {
    reset();
    repo.edit("src/index.ts", "return \"demo\";", "return \"demo!\";");
    const { res, claim } = await reviewDrift();
    expect(claim).toBeUndefined();
    expect(res.verdict).toBe("PASS");
  });

  it("R1: pins current next behavior (B plus the vision hash replaced by the observed value, the undocumented manual recovery: ALIGNED, PASS)", async () => {
    reset();
    repo.edit("README.md", "Run the demo with node.", "Run the demo with Node.js 24 or newer.");
    const observed = sliceHash(repo.read("README.md"));
    repo.edit(VISION, `hash: ${RECORDED}`, `hash: ${observed}`);
    const { res, claim } = await reviewDrift();
    expect(claim).toMatchObject({ subject: { kind: "vision", id: VISION }, alignment: "ALIGNED", reason: "external-source-unchanged" });
    expect(res.verdictBasis.warn).toEqual([]);
    expect(res.verdict).toBe("PASS");
  });

  it.todo(
    "R1 follow-up (#7, Jira S15P31A106-262 / -324): a person re-approves a changed source through a documented flow instead of editing the hash by hand, and review uses that record",
  );

  it("S1: pins current next behavior (the vision source names the H1 section `demo`; the B edit is still WARN because an H1 section covers the whole README)", async () => {
    reset();
    expect(sliceHash(README, "demo")).toBe(RECORDED);
    repo.edit(VISION, `    hash: ${RECORDED}\n`, `    hash: ${RECORDED}\n    section: demo\n`);
    repo.git("commit", "-qam", "vision source names the H1 section");
    try {
      repo.edit("README.md", "Run the demo with node.", "Run the demo with Node.js 24 or newer.");
      const { res, claim } = await reviewDrift();
      expectChanged(res, claim, sliceHash(repo.read("README.md"), "demo"), "README.md § demo");
    } finally {
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it.todo(
    "S1 follow-up (#7, Jira S15P31A106-263 / -327): a source narrower than the H1 section (the adopted paragraph or a sub-section) separates A from B",
  );
});
