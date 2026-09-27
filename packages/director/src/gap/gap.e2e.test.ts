import fs from "node:fs";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderContextMarkdown } from "../context/render.js";
import { contextRegistry, GAP_FIXTURE, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { assessKnowledgeGaps } from "./assess.js";
import { renderGapQuestions } from "./render.js";
import type { KnowledgeGap, KnowledgeGapAssessment } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
let registry: AnalyzerRegistry;
let repo: ContextRepo;
beforeAll(async () => {
  registry = await contextRegistry();
  repo = makeContextRepo(temps, registry, GAP_FIXTURE);
  await repo.index();
});
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

async function assess(r: ContextRepo, task: string) {
  const result = await r.compile({ task });
  return { result, a: assessKnowledgeGaps({ request: { task }, result, truth: r.truth() }) };
}
const byText = (a: KnowledgeGapAssessment, text: string): KnowledgeGap | undefined => a.gaps.find((g) => g.text === text);
const brief = (g: KnowledgeGap | undefined) => (g === undefined ? undefined : [g.kind, g.relevance, g.action]);

const TASK_A = "DB migration index 추가";
const TASK_B = "멀티플레이 서버 확장 구조 설계";
const MAX_USERS = "최대 동시 접속자 수";

describe("Knowledge Gap assessment (TASK-011)", () => {
  it("declared gaps come from prose in Requirements, Decisions, Issues and project documents, never from code", () => {
    const gaps = repo.truth().gaps.map((g) => [g.owner.type === "project" ? "project" : g.owner.id, g.key ?? null, g.text]);
    const sorted = (x: (string | null)[][]) => [...x].sort((p, q) => String(p[2]).localeCompare(String(q[2]), "en"));
    expect(sorted(gaps)).toEqual(sorted([
      ["D-030", null, "reconnect policy after a node failure"],
      ["project", null, "최종 배포 플랫폼"],
      ["NET-7", null, "load test environment"],
      ["project", null, "서버 운영 비용 한도"],
      ["NETWORK-01", "max_concurrent_users", MAX_USERS],
      ["DATA-01", "migration_tool", "migration tool"],
    ]));
    const all = JSON.stringify(gaps);
    for (const t of ["inline example", "fenced example", "sample comment inside a fence"]) expect(all).not.toContain(t);
  });

  it("the core case, Task A: an unrelated known unknown is not asked", async () => {
    const { result, a } = await assess(repo, TASK_A);
    expect(result.status).toBe("ready");
    expect(brief(byText(a, MAX_USERS))).toEqual(["declared", "none", "ignore"]);
    expect(a.requiresHumanInput).toBe(false);
    expect(a.primary).toBeUndefined();
    // AC-011-03: the ignored gap is counted, not placed in the Packet.
    expect(a.metrics.ignore).toBe(6);
    expect(renderContextMarkdown(result.packet ?? (undefined as never))).not.toContain(MAX_USERS);
  });

  it("the core case, Task B: the same gap is in the task's subgraph and becomes a question", async () => {
    const { result, a } = await assess(repo, TASK_B);
    expect(result.packet?.seeds.map((s) => s.ref)).toEqual(["NETWORK-01"]);
    const gap = byText(a, MAX_USERS);
    expect(brief(gap)).toEqual(["declared", "direct", "ask"]);
    expect(gap?.reasons).toEqual([{ code: "task-seed", ref: "NETWORK-01" }, { code: "no-resolution" }]);
    expect(gap?.anchors).toEqual([{ type: "requirement", id: "NETWORK-01" }]);
    expect(a.requiresHumanInput).toBe(true);
  });

  it("direct, related and unrelated gaps; project gaps are at most surfaced", async () => {
    const { a } = await assess(repo, TASK_B);
    expect(brief(byText(a, "reconnect policy after a node failure"))).toEqual(["declared", "direct", "ask"]);
    expect(byText(a, "reconnect policy after a node failure")?.reasons[0]).toEqual({ code: "near-intent", ref: "D-030", detail: "1 edge from a seed" });
    expect(brief(byText(a, "load test environment"))).toEqual(["declared", "related", "surface"]);
    expect(brief(byText(a, "서버 운영 비용 한도"))).toEqual(["declared", "related", "surface"]);
    expect(byText(a, "서버 운영 비용 한도")?.reasons).toContainEqual({ code: "keyword-overlap", ref: "task", detail: "서버" });
    expect(brief(byText(a, "최종 배포 플랫폼"))).toEqual(["declared", "none", "ignore"]);
  });

  it("an already-resolved gap is not asked again, even when it is directly relevant", async () => {
    const { a } = await assess(repo, TASK_A);
    const gap = byText(a, "migration tool");
    expect(brief(gap)).toEqual(["declared", "direct", "ignore"]);
    expect(gap?.resolution).toEqual({ status: "resolved", decision: "D-031" });
    expect(gap?.reasons).toContainEqual({ code: "resolved-by-decision", ref: "D-031", detail: "migration_tool" });
  });

  it("relevant pending proposal: ask, never stated as intent; unrelated task: absent", async () => {
    const b = (await assess(repo, TASK_B)).a;
    const pending = b.gaps.find((g) => g.kind === "pending-decision");
    expect(pending).toMatchObject({ source: "runtime", action: "ask", relevance: "direct", pending: { id: "P-040", relatesTo: ["NETWORK-01"] } });
    expect(JSON.stringify(pending)).not.toContain("udp");
    expect(renderGapQuestions(b).primaryQuestion).not.toContain("udp");
    const a = (await assess(repo, TASK_A)).a;
    expect(a.gaps.some((g) => g.kind === "pending-decision")).toBe(false);
  });

  it("multiple asks: one deterministic primary question, the rest in priority order", async () => {
    const one = (await assess(repo, TASK_B)).a;
    const two = (await assess(repo, TASK_B)).a;
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    const ask = one.gaps.filter((g) => g.action === "ask").map((g) => g.kind + ":" + (g.pending?.id ?? g.text));
    expect(ask).toEqual(["pending-decision:P-040", `declared:${MAX_USERS}`, "declared:reconnect policy after a node failure"]);
    expect(one.primary).toBe(one.gaps[0]?.id);
    expect(one.additional).toEqual(one.gaps.slice(1, 3).map((g) => g.id));
    const q = renderGapQuestions(one);
    expect(q.primaryQuestion).toBe('P-040 "UDP transport for realtime state"는 아직 확정되지 않은 제안입니다. 이 작업(NETWORK-01)은 이 결정에 의존하므로 확정 또는 거절이 필요합니다.');
    expect(q.additionalQuestions.map((x) => x.question)).toEqual([
      `NETWORK-01의 미확정 사항: "${MAX_USERS}". 이 작업에 영향을 주므로 값을 정해 주세요.`,
      'D-030의 미확정 사항: "reconnect policy after a node failure". 이 작업에 영향을 주므로 값을 정해 주세요.',
    ]);
    expect(renderGapQuestions(two)).toEqual(q);
  });

  it("ambiguous symbol task: ask with the real candidates, choose none", async () => {
    const { result, a } = await assess(repo, "fix normalize");
    expect(result.status).toBe("ambiguous");
    expect(a.gaps[0]).toMatchObject({ kind: "ambiguous-target", action: "ask", term: "normalize" });
    expect(a.gaps[0]?.options?.map((o) => o.ref)).toEqual(["src/net/normalize.ts#normalize", "src/util/normalize.ts#normalize"]);
    expect(a.primary).toBe(a.gaps[0]?.id);
    expect(renderGapQuestions(a).primaryQuestion).toContain("src/net/normalize.ts#normalize, src/util/normalize.ts#normalize");
  });

  it("missing explicit Requirement ID: an unresolved target, asked", async () => {
    const { result, a } = await assess(repo, "AUTH-99 수정");
    expect(result.status).toBe("insufficient-context");
    expect(a.gaps[0]).toMatchObject({ kind: "unresolved-target", action: "ask", target: "AUTH-99" });
    expect(renderGapQuestions(a).primaryQuestion).toBe("AUTH-99가 현재 Project Truth에 없습니다. 어떤 Requirement/Issue를 의미하는지 확인이 필요합니다.");
    expect(a.requiresHumanInput).toBe(true);
  });

  it("code-only task with no confirmed intent: surfaced, not blocking; unresolved calls are no human question", async () => {
    const { result, a } = await assess(repo, "printSize");
    expect(result.packet?.seeds[0]?.ref).toBe("src/tools/format.ts#printSize");
    // out.write() cannot be resolved (injected object): no CALLS edge besides the exact formatBytes call.
    const calls = repo.graphDump().edges.filter((e) => e.includes('"type":"CALLS"') && e.includes("printSize"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("formatBytes");
    expect(a.gaps.filter((g) => g.action !== "ignore").map((g) => [g.kind, g.action])).toEqual([["missing-intent", "surface"]]);
    expect(a.requiresHumanInput).toBe(false);
    expect(a.technicalLimitations).toContain("calls-exact-only");
    expect(a.technicalLimitations).not.toContain("no-confirmed-intent");
  });

  it("stable gap IDs: a line added above a gap keeps it", async () => {
    const work = makeContextRepo(temps, registry, GAP_FIXTURE);
    await work.index();
    const before = work.truth().gaps.find((g) => g.text === MAX_USERS);
    work.edit(".duo-project/specs/network.md", "# Network\n", "# Network\n\nIntro paragraph added later.\n");
    const after = work.truth().gaps.find((g) => g.text === MAX_USERS);
    expect(after?.id).toBe(before?.id);
    expect(after?.location.startLine).toBe((before?.location.startLine ?? 0) + 2);
  });

  it("freshness, AC-011-04 and explicit resolution on a working copy", async () => {
    const work = makeContextRepo(temps, registry, GAP_FIXTURE);
    await work.index();
    // A stale index yields no judgement at all.
    work.edit("src/db/migrate.ts", "/** Runs the steps", "/** Runs every step");
    const stale = await assess(work, TASK_B);
    expect(stale.result.status).toBe("index-required");
    expect(stale.a).toMatchObject({ status: "index-required", gaps: [], requiresHumanInput: false });
    await work.index();

    // A confirmed Decision that answers the key for the owner resolves the gap.
    work.write(".duo-project/decisions/D-032.yaml", [
      "id: D-032", "title: Capacity target", "kind: decision", "state: confirmed", "question: max_concurrent_users", "answer: 2000 per node",
      "owner: human", "governs:", "  requirements: [NETWORK-01]", "supersedes: null", "superseded_by: null",
      'confirmed_at: "2026-09-27T00:00:00Z"', "confirmed_by: tester", "",
    ].join("\n"));
    await work.index();
    const resolved = byText((await assess(work, TASK_B)).a, MAX_USERS);
    expect(resolved?.action).toBe("ignore");
    expect(resolved?.resolution).toEqual({ status: "resolved", decision: "D-032" });
    fs.rmSync(`${work.root}/.duo-project/decisions/D-032.yaml`);

    // Deleting the UNKNOWN line: the gap is no longer declared.
    work.edit(".duo-project/specs/network.md", "UNKNOWN(max_concurrent_users): 최대 동시 접속자 수\n", "");
    await work.index();
    const { a } = await assess(work, TASK_B);
    expect(byText(a, MAX_USERS)).toBeUndefined();
    expect(a.metrics.declaredConsidered).toBe(5);
  });

  it("no LLM: llmCalls is 0 on every path", async () => {
    for (const task of [TASK_A, TASK_B, "fix normalize", "AUTH-99 수정", "printSize"]) expect((await assess(repo, task)).a.metrics.llmCalls).toBe(0);
  });
});

