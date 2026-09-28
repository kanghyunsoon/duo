/**
 * planInit() (TASK-014): inspect → observe → discover documents → questions → InitPlan. Read-only: it
 * never writes, indexes or calls an LLM. Git is required (C36): a directory that is not a Git work tree
 * is GIT_REPOSITORY_REQUIRED, a subdirectory of one is SCAN_ROOT_INVALID, so no nested Truth Layer is
 * planned. The plan is plain data a CLI or UI can show before anything is written.
 */
import { openGitProvider, scanRepository } from "@duo-director/analyzer";
import {
  compareUtf8, createDiagnostic, failure, hasErrors, sha256Text, stableJson, success, type Diagnostic, type ParseResult, type RepoPath,
} from "@duo-director/core";
import { observeWorkingTree } from "../adoption/worktree.js";
import { discoverDocuments, type DiscoveryOptions } from "./documents.js";
import { inspectStateDirectory } from "./inspect.js";
import { INIT_DIRECTORIES, INIT_FILES, milestoneFile } from "./layout.js";
import { observeRepository } from "./observe.js";
import type { InitConflict, InitPlan, InitQuestion, PlannedFile } from "./types.js";

export interface PlanInitOptions {
  readonly discovery?: DiscoveryOptions;
}

const MAX_WARNINGS = 20;
const MAX_LISTED_PATHS = 50;

/** sha256 of the plan without its digest field. */
export function initPlanDigest(plan: Omit<InitPlan, "digest"> | InitPlan): string {
  const { digest: _omit, ...body } = plan as InitPlan;
  void _omit;
  return sha256Text(stableJson(body));
}

function nextMilestoneId(existing: readonly RepoPath[]): string {
  const numbers = existing.flatMap((p) => /\/milestones\/M(\d+)\.(?:ya?ml|md)$/u.exec(p)?.[1] ?? []).map(Number);
  return `M${numbers.length === 0 ? 1 : Math.max(...numbers) + 1}`;
}

export async function planInit(root: string, options: PlanInitOptions = {}): Promise<ParseResult<InitPlan>> {
  const git = await openGitProvider(root);
  if (git.value === undefined) return failure(git.diagnostics);
  const repoState = await git.value.repositoryState();
  if (repoState.value === undefined) return failure(repoState.diagnostics);
  const scan = await scanRepository(root);
  if (hasErrors(scan.diagnostics)) return failure(scan.diagnostics.filter((d) => d.severity === "error"));

  const tree = await observeWorkingTree(git.value, MAX_LISTED_PATHS);
  if (tree.value === undefined) return failure(tree.diagnostics);
  const inspection = inspectStateDirectory(root);
  const observed = observeRepository(root, scan, repoState.value, tree.value);
  const discovery = discoverDocuments(root, scan.files.map((f) => f.path), observed.description?.value, options.discovery);

  const planning = inspection.state === "not-initialized" || inspection.state === "partial";
  const milestone = nextMilestoneId(inspection.existing);
  const layoutFiles: PlannedFile[] = [
    { path: INIT_FILES.project, kind: "project-truth", when: "always" },
    { path: INIT_FILES.gitignore, kind: "project-truth", when: "always" },
    { path: INIT_FILES.vision, kind: "project-truth", when: "always" },
    { path: INIT_FILES.constraints, kind: "project-truth", when: "always" },
    { path: milestoneFile(milestone), kind: "project-truth", when: "answered", question: "current_milestone" },
  ];
  const conflicts: InitConflict[] = [...inspection.conflicts];
  const willCreate: PlannedFile[] = [];
  const directories: RepoPath[] = [];
  const missing: RepoPath[] = [];
  if (planning) {
    for (const f of layoutFiles) {
      const e = inspection.entries.get(f.path);
      if (e === undefined) { willCreate.push(f); missing.push(f.path); }
      else if (e.type !== "file" && !conflicts.some((c) => c.path === f.path)) conflicts.push({ path: f.path, reason: e.type === "symlink" ? "symlink" : "not-a-file" });
    }
    for (const d of INIT_DIRECTORIES) {
      const e = inspection.entries.get(d.path);
      if (e === undefined) directories.push(d.path);
      else if (e.type !== "directory" && !conflicts.some((c) => c.path === d.path)) conflicts.push({ path: d.path, reason: e.type === "symlink" ? "symlink" : "not-a-directory" });
    }
  }
  conflicts.sort((a, b) => compareUtf8(a.path, b.path));
  const blockers: Diagnostic[] = [...inspection.blockers];
  for (const c of conflicts.filter((x) => !inspection.conflicts.some((i) => i.path === x.path))) {
    blockers.push(createDiagnostic("INIT_CONFLICT", `"${c.path}" is in the way of a planned ${c.reason === "not-a-directory" ? "directory" : "file"} (${c.reason}); init does not write over it`, { path: c.path }));
  }
  const creates = (p: RepoPath) => willCreate.some((f) => f.path === p);
  const questions: InitQuestion[] = [];
  if (planning && conflicts.length === 0) {
    if (creates(INIT_FILES.vision)) {
      questions.push({
        id: "project_goal", kind: "text", promptKey: "init.question.project_goal", required: true,
        ...(discovery.goal?.suggestedValue === undefined ? {} : { suggestedValue: discovery.goal.suggestedValue }),
        ...(discovery.goal?.evidence === undefined ? {} : { evidence: discovery.goal.evidence }),
      });
    }
    if (creates(INIT_FILES.project)) questions.push({ id: "current_milestone", kind: "milestone", promptKey: "init.question.current_milestone", required: false });
    if (creates(INIT_FILES.constraints)) questions.push({ id: "critical_constraints", kind: "list", promptKey: "init.question.critical_constraints", required: false });
  }
  const applicable = planning && conflicts.length === 0;
  const body: Omit<InitPlan, "digest"> = {
    format: "duo.init-plan/1", state: inspection.state, applicable, requiresRepair: inspection.state === "partial" && applicable,
    blockers, observed, documents: discovery.documents, importCandidates: discovery.importCandidates, questions,
    willCreate: applicable ? willCreate : [], directories: applicable ? directories : [],
    existing: inspection.existing, missing: planning ? missing : [], conflicts, allocations: { milestone },
    warnings: scan.diagnostics.filter((d) => d.severity === "warning").slice(0, MAX_WARNINGS),
    indexRequired: true, basis: inspection.basis,
  };
  return success({ ...body, digest: initPlanDigest(body) });
}

