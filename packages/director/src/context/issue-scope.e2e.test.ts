/**
 * H-78 (T45, F-25): an exact Issue ID reaches the active Decisions that govern the files the Issue declares it
 * implements: TASK-015 ← IMPLEMENTS ← File ← GOVERNS ← Decision, through the ordinary graph traversal. No path is
 * read from an Issue body, depends_on is not inherited, superseded Decisions and proposals are not authority.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewChanges } from "../review/review.js";
import { contextRegistry, makeContextRepo, type ContextRepo } from "./testing.js";
import type { ContextResult } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const issue = (id: string, title: string, block: string[], body: string, acs: number) => [
  `## ${id} ${title}`, "", "```duo", "type: issue", "status: todo", ...block, "```", "", body, "",
  ...Array.from({ length: acs }, (_, k) => `- **AC-${id.slice(5)}-${String(k + 1).padStart(2, "0")}** ${title} criterion ${k + 1}.`), "",
].join("\n");
const decision = (id: string, title: string, paths: string[]) =>
  `id: ${id}\ntitle: ${title}\nkind: decision\nstate: proposed\nquestion: ${id.toLowerCase()}_rule\nanswer: ${title}\ngoverns:\n  paths: [${paths.map((p) => JSON.stringify(p)).join(", ")}]\nenforcement: warn\n`;

function writeFixture(dir: string): void {
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w("package.json", JSON.stringify({ name: "issue-scope", version: "1.0.0", type: "module" }) + "\n");
  w("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "nodenext" } }) + "\n");
  w(".duo-project/project.yaml", "schema_version: 1\nname: issue-scope\n");
  w(".duo-project/specs/tasks.md", ["# Tasks", "",
    // Windows separators in the declared scope are normalized like a Requirement's.
    issue("TASK-015", "Desktop shell", ["implements:", "  paths: [\"apps\\\\desktop\\\\**\"]", "depends_on: [TASK-007]"], "Build the desktop shell window. Do not modify apps/payment/** and compare with apps/legacy/main.ts.", 4),
    issue("TASK-007", "Payment charge", ["implements:", "  paths: [\"apps/payment/**\"]"], "Charge cards once.", 2),
    issue("TASK-020", "Desktop follow-up", [], "Touch apps/desktop/src/main.ts later.", 2),
  ].join("\n"));
  w(".duo-project/decisions/D-001.yaml", decision("D-001", "Sessions use opaque tokens", ["src/auth/**"]));
  w(".duo-project/decisions/D-003.yaml", decision("D-003", "Desktop uses one window", ["apps/desktop/**"]));
  w(".duo-project/decisions/D-005.yaml", decision("D-005", "Desktop renderer is sandboxed", ["apps/desktop/**"]));
  w(".duo-project/decisions/D-006.yaml", decision("D-006", "Charges are idempotent", ["apps/payment/**"]));
  w("apps/desktop/src/main.ts", "export function createWindow(): string {\n  return \"window\";\n}\n");
  w("apps/payment/charge.ts", "export function charge(n: number): number {\n  return n;\n}\n");
  w("apps/legacy/main.ts", "export const legacy = 1;\n");
  w("src/auth/session.ts", "export class Session {\n  open(user: string): string {\n    return user;\n  }\n}\n");
}

const active = (r: ContextResult) => r.packet?.decisions.active.map((d) => d.ref) ?? [];
const viaTypes = (r: ContextResult, ref: string) => r.packet?.decisions.active.find((d) => d.ref === ref)?.via?.steps.map((s) => `${s.from} ${s.type} ${s.to}`) ?? [];

describe("Issue.implements.paths reaches governing Decisions (H-78, F-25)", () => {
  let registry: AnalyzerRegistry;
  let repo: ContextRepo;
  beforeAll(async () => {
    registry = await contextRegistry();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "duo-issue-scope-"));
    temps.push(fixture);
    writeFixture(fixture);
    repo = makeContextRepo(temps, registry, fixture);
    const s = createDecisionService({ root: repo.root, clock: () => new Date("2026-10-07T00:00:00Z") });
    const human = { kind: "human", name: "Ada" } as const;
    for (const id of ["D-001", "D-003", "D-005", "D-006"]) expect((await s.confirm(human, id)).value?.decisionId).toBe(id);
    // D-007 supersedes D-003 (current authority); P-008 is only a proposal for the same scope.
    const p = await s.propose({ kind: "agent", name: "codex" }, { title: "Desktop uses tabs", question: "d-003_rule", answer: "tabs", governs: { paths: ["apps/desktop/**"] }, supersedes: "D-003" });
    expect((await s.confirm(human, p.value?.proposalId ?? "")).value?.decisionId).toBe("D-007");
    expect((await s.propose({ kind: "agent", name: "codex" }, { title: "Desktop logs to a file", question: "desktop_logging", answer: "file", governs: { paths: ["apps/desktop/**"] } })).value).toBeDefined();
    repo.git("add", "-A");
    repo.git("commit", "-qm", "decisions");
    await repo.index();
  });

  it("TASK-015 alone: the governing active Decisions through IMPLEMENTS then GOVERNS, the seed stays the Issue ID", async () => {
    const r = await repo.compile({ task: "TASK-015", budget: 6000 });
    expect(r.packet?.seeds).toMatchObject([{ ref: "TASK-015", match: "id" }]);
    expect(active(r)).toEqual(expect.arrayContaining(["D-005", "D-007"]));
    expect(viaTypes(r, "D-005")).toEqual(["apps/desktop/src/main.ts IMPLEMENTS TASK-015", "D-005 GOVERNS apps/desktop/src/main.ts"]);
    const code = r.packet?.code.map((c) => c.ref) ?? [];
    expect(code.some((c) => c.startsWith("apps/desktop/src/main.ts"))).toBe(true);
    // Not authority: superseded D-003, the proposal; not in scope: payment (body text, depends_on TASK-007), legacy.
    expect(active(r)).not.toContain("D-003");
    expect(active(r)).not.toContain("D-006");
    expect(active(r).some((x) => x.startsWith("P-"))).toBe(false);
    expect(code.some((c) => c.startsWith("apps/payment/") || c.startsWith("apps/legacy/"))).toBe(false);
    // H-76: the named Issue keeps its full specification within the budget.
    const seed = r.packet?.issues.find((i) => i.ref === "TASK-015");
    expect(seed?.level).toBe("L3");
    expect(seed?.text).toContain("AC-015-04");
    expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(6000);
  });

  it("an Issue without implements gets no path scope from its body; depends_on is not inherited", async () => {
    const r = await repo.compile({ task: "TASK-020", budget: 6000 });
    expect(active(r)).not.toContain("D-005");
    expect(active(r)).not.toContain("D-007");
    const pay = await repo.compile({ task: "TASK-007", budget: 6000 });
    expect(active(pay)).toContain("D-006");
    expect(active(pay)).not.toContain("D-005");
  });

  it("a small budget never exceeds the budget and keeps the Issue", async () => {
    for (const budget of [1200, 2000]) {
      const r = await repo.compile({ task: "TASK-015", budget });
      expect(r.packet?.metrics.budget.used).toBeLessThanOrEqual(budget);
      expect(r.packet?.issues.some((i) => i.ref === "TASK-015")).toBe(true);
    }
  });

  it("an explicit path query already reached the governing Decision and still does", async () => {
    const r = await repo.compile({ task: "Modify src/auth/session.ts", budget: 6000 });
    expect(active(r)).toContain("D-001");
    expect(viaTypes(r, "D-001")).toEqual(["D-001 GOVERNS src/auth/session.ts"]);
  });

  it("the graph links only the declared scope", () => {
    const edges = repo.graphDump().edges.filter((e) => e.includes('"type":"IMPLEMENTS"'));
    expect(edges.some((e) => e.includes("apps/desktop/src/main.ts") && e.includes("issue:TASK-015"))).toBe(true);
    expect(edges.some((e) => e.includes("apps/payment/charge.ts") && e.includes("issue:TASK-007"))).toBe(true);
    expect(edges.some((e) => e.includes("issue:TASK-020"))).toBe(false);
    expect(edges.some((e) => e.includes("apps/legacy/main.ts"))).toBe(false);
  });
it("Review: an Issue IMPLEMENTS edge is not a Requirement link (unlinked-addition stays; no Issue in Requirement claims)", async () => {
    const opened = openProjectGraphStore(repo.root);
    if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
    repo.write("apps/desktop/src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
    try {
      await repo.index();
      const graph = openProjectGraphStore(repo.root);
      if (graph.value === undefined) throw new Error("graph");
      try {
        const out = await reviewChanges(repo.root, { task: "TASK-007", diff: { from: "HEAD", to: "WORKTREE" } }, { graph: graph.value, registry, historyWindow: 20 });
        const res = out.value?.result;
        expect(res?.claims.filter((c) => c.rule === "unlinked-addition").map((c) => c.subject.id)).toEqual(["apps/desktop/src/extra.ts"]);
        expect(res?.claims.some((c) => c.subject.kind === "requirement" && c.subject.id.startsWith("TASK-"))).toBe(false);
        expect(JSON.stringify(res?.claims ?? [])).not.toContain("issue:TASK");
      } finally {
        graph.value.close();
      }
    } finally {
      opened.value.close();
      fs.rmSync(path.join(repo.root, "apps/desktop/src/extra.ts"));
      await repo.index();
    }
  });
});
