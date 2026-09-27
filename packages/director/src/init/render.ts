/**
 * Rendering the planned files from a plan and the human's answers (TASK-014). Pure: the same plan and
 * answers give the same bytes; no clock, no randomness. Only answers become confirmed Truth:
 * - vision.md is "confirmed" only with a human-given goal (typed, or an accepted suggestion, which
 *   then carries its External Source provenance); otherwise it is a "draft" without any goal text;
 * - every question left open becomes an UNKNOWN(question-id) line: a Declared Knowledge Gap, derived
 *   from Truth like every other gap (no gaps.json, C94);
 * - constraints.yaml holds only human-given statements (confirmed, enforcement warn: hard blocking is a
 *   Decision's job, C107); an unanswered question leaves it empty;
 * - a milestone is written only when the human names one. No invented "M1 MVP".
 */
import { stringifyYaml, SUPPORTED_SCHEMA_VERSIONS, type RepoPath, type WriteKind } from "@duo-director/core";
import { GITIGNORE_TEXT, INIT_FILES, milestoneFile } from "./layout.js";
import type { InitPlan, InitQuestionId } from "./types.js";

export interface NormalizedAnswers {
  readonly goal?: { readonly value: string; readonly source?: { readonly path: RepoPath; readonly hash: string } };
  readonly milestone?: { readonly title: string };
  readonly constraints?: readonly string[];
}

const OPEN_TEXT: Readonly<Record<InitQuestionId, string>> = {
  project_goal: "The project goal is not confirmed by a human yet.",
  current_milestone: "The current milestone or MVP scope is not confirmed by a human yet.",
  critical_constraints: "The critical constraints are not confirmed by a human yet.",
};

export function openQuestionsOf(plan: InitPlan, a: NormalizedAnswers): InitQuestionId[] {
  return plan.questions.map((q) => q.id).filter((id) =>
    (id === "project_goal" && a.goal === undefined) || (id === "current_milestone" && a.milestone === undefined) || (id === "critical_constraints" && a.constraints === undefined));
}

export function renderInitFiles(plan: InitPlan, a: NormalizedAnswers): Map<RepoPath, { readonly kind: WriteKind; readonly text: string }> {
  const out = new Map<RepoPath, { kind: WriteKind; text: string }>();
  const planned = new Set(plan.willCreate.map((f) => f.path));
  const put = (p: RepoPath, text: string) => { if (planned.has(p)) out.set(p, { kind: "project-truth", text }); };
  const milestone = plan.allocations.milestone;
  put(INIT_FILES.project, stringifyYaml({
    schema_version: Math.max(...SUPPORTED_SCHEMA_VERSIONS), name: plan.observed.name.value, current_milestone: a.milestone === undefined ? null : milestone,
  }));
  put(INIT_FILES.gitignore, GITIGNORE_TEXT);
  const open = openQuestionsOf(plan, a);
  const front = stringifyYaml({
    status: a.goal === undefined ? "draft" : "confirmed", owner: "human",
    ...(a.goal?.source === undefined ? {} : { source: [{ path: a.goal.source.path, hash: a.goal.source.hash }] }),
  });
  const parts = [`---\n${front}---\n`, "# Vision\n"];
  if (a.goal !== undefined) parts.push(`${a.goal.value}\n`);
  if (open.length > 0) parts.push("## Open questions\n", ...open.map((id) => `UNKNOWN(${id}): ${OPEN_TEXT[id]}\n`));
  put(INIT_FILES.vision, parts.join("\n"));
  put(INIT_FILES.constraints, stringifyYaml({
    constraints: (a.constraints ?? []).map((statement, i) => ({ id: `CON-${String(i + 1).padStart(3, "0")}`, statement, state: "confirmed", enforcement: "warn" })),
  }));
  if (a.milestone !== undefined) put(milestoneFile(milestone), stringifyYaml({ id: milestone, title: a.milestone.title, state: "active" }));
  return out;
}

