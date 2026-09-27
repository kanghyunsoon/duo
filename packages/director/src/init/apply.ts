/**
 * applyInitPlan() (TASK-014). Writes exactly the files of a plan planInit() produced, from the plan and
 * the human's answers, and nothing else:
 *
 *   verify plan (digest, known paths) → .duo-project unchanged since planning (basis) → answers →
 *   render → guard every path (write boundary, no symlink) → stage under runtime/ → load the staged
 *   Truth with the core loader (schema, trace, paths) → move each staged file into place (exclusive,
 *   project.yaml last) → remove the staging area
 *
 * On any failure every file and directory this apply created is removed again, so the repository is
 * left as it was (a crash between two moves can still leave a partial state, which planInit reports).
 * An existing project is never changed (INIT_ALREADY_INITIALIZED); a partial one only with repair: true,
 * which adds the missing files and keeps every existing one. Init never indexes and never calls an LLM.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  compareUtf8, createDiagnostic, failure, guardDirectory, guardWrite, isDefinitionId, loadProjectTruth, STATE_DIR_NAME, success, WRITE_AREAS,
  type Diagnostic, type ParseResult, type RepoPath,
} from "@duo-director/core";
import { inspectStateDirectory } from "./inspect.js";
import { INIT_DIRECTORIES, INIT_FILES, milestoneFile } from "./layout.js";
import { initPlanDigest } from "./plan.js";
import { openQuestionsOf, renderInitFiles, type NormalizedAnswers } from "./render.js";
import type { InitAnswer, InitApplyResult, InitPlan } from "./types.js";

/** File operations of apply (injectable for failure tests). */
export interface InitFileSystem {
  /** Creates one directory (not recursive); false when it already exists as a directory. */
  mkdir(absolute: string): Promise<boolean>;
  writeFile(absolute: string, text: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  /** Puts a staged file at target; fails when target exists. */
  place(staged: string, target: string): Promise<void>;
  removeFile(absolute: string): Promise<void>;
  /** Removes an empty directory (a non-empty one is left alone). */
  removeDir(absolute: string): Promise<void>;
  removeTree(absolute: string): Promise<void>;
}

export const nodeInitFileSystem: InitFileSystem = {
  async mkdir(absolute) {
    try {
      await fsp.mkdir(absolute);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && fs.lstatSync(absolute).isDirectory()) return false;
      throw error;
    }
  },
  writeFile: (absolute, text) => fsp.writeFile(absolute, text, { encoding: "utf8", flag: "wx" }),
  copyFile: (from, to) => fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL),
  async place(staged, target) {
    try {
      await fsp.link(staged, target); // atomic, fails when target exists
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw error;
      await fsp.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
    }
  },
  removeFile: (absolute) => fsp.rm(absolute, { force: true }),
  async removeDir(absolute) {
    try {
      await fsp.rmdir(absolute);
    } catch {
      // not empty or already gone: leave it
    }
  },
  removeTree: (absolute) => fsp.rm(absolute, { recursive: true, force: true }),
};

export interface ApplyInitOptions {
  /** Required for a partial .duo-project: create the missing files, keep every existing one. */
  readonly repair?: boolean;
  readonly fs?: InitFileSystem;
}

const MAX_GOAL = 4000;
const MAX_LINE = 500;
const invalid = (message: string) => failure<never>([createDiagnostic("INIT_ANSWER_INVALID", message)]);

/** Checks the answers against the plan's questions. */
export function normalizeInitAnswers(plan: InitPlan, answers: readonly InitAnswer[]): ParseResult<NormalizedAnswers> {
  const asked = new Map(plan.questions.map((q) => [q.id, q] as const));
  const seen = new Set<string>();
  let goal: NormalizedAnswers["goal"];
  let milestone: NormalizedAnswers["milestone"];
  let constraints: string[] | undefined;
  for (const a of answers) {
    const q = asked.get(a.question);
    if (q === undefined) return invalid(`"${String(a.question)}" is not a question of this plan`);
    if (seen.has(a.question)) return invalid(`"${a.question}" is answered twice`);
    seen.add(a.question);
    if (a.question === "project_goal") {
      const value = a.value.trim();
      if (value === "" || value.length > MAX_GOAL) return invalid(`project_goal must be 1 to ${MAX_GOAL} characters`);
      if (a.acceptSuggestion === true) {
        if (q.suggestedValue === undefined || value !== q.suggestedValue.trim()) return invalid("project_goal accepts a suggestion that differs from the plan's suggestedValue");
        const ev = q.evidence?.find((e) => e.hash !== undefined && e.field === undefined);
        goal = { value, ...(ev?.hash === undefined ? {} : { source: { path: ev.path, hash: ev.hash } }) };
      } else {
        goal = { value };
      }
    } else if (a.question === "current_milestone") {
      const title = a.title.trim();
      if (title === "" || title.length > MAX_LINE || /[\r\n]/u.test(title)) return invalid(`current_milestone title must be one line of 1 to ${MAX_LINE} characters`);
      milestone = { title };
    } else {
      const list: string[] = [];
      for (const s of a.statements) {
        const t = s.trim();
        if (t === "" || t.length > MAX_LINE || /[\r\n]/u.test(t)) return invalid(`each critical constraint must be one line of 1 to ${MAX_LINE} characters`);
        if (!list.includes(t)) list.push(t);
      }
      constraints = list;
    }
  }
  return success({ ...(goal === undefined ? {} : { goal }), ...(milestone === undefined ? {} : { milestone }), ...(constraints === undefined ? {} : { constraints }) });
}

/** A plan whose files and directories are exactly ones init knows how to make. */
function verifyPlan(plan: InitPlan): Diagnostic[] {
  const bad = (m: string) => [createDiagnostic("INIT_PLAN_INVALID", m)];
  if (plan.format !== "duo.init-plan/1" || plan.digest !== initPlanDigest(plan)) return bad("The plan was not produced by planInit() or was changed after planning (digest mismatch)");
  const id = plan.allocations.milestone;
  if (!/^M\d+$/u.test(id) || !isDefinitionId(id)) return bad(`Invalid milestone allocation "${id}"`);
  const known = new Set<string>([...Object.values(INIT_FILES), milestoneFile(id)]);
  const unknown = plan.willCreate.filter((f) => !known.has(f.path) || f.kind !== "project-truth").map((f) => f.path);
  const dirs = new Set(INIT_DIRECTORIES.map((d) => d.path));
  unknown.push(...plan.directories.filter((d) => !dirs.has(d)));
  return unknown.length > 0 ? bad(`The plan names paths init does not create: ${unknown.join(", ")}`) : [];
}

const PROJECT_TRUTH_PREFIXES = WRITE_AREAS["project-truth"].map((a) => `${STATE_DIR_NAME}/${a}`);
const isTruthFile = (p: string) => PROJECT_TRUTH_PREFIXES.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));

export async function applyInitPlan(root: string, plan: InitPlan, answers: readonly InitAnswer[], options: ApplyInitOptions = {}): Promise<ParseResult<InitApplyResult>> {
  const io = options.fs ?? nodeInitFileSystem;
  const planProblems = verifyPlan(plan);
  if (planProblems.length > 0) return failure(planProblems);
  if (!plan.applicable) return failure(plan.blockers.length > 0 ? plan.blockers : [createDiagnostic("INIT_PLAN_INVALID", "The plan is not applicable")]);
  if (plan.requiresRepair && options.repair !== true) {
    return failure([createDiagnostic("INIT_REPAIR_REQUIRED", `${STATE_DIR_NAME} exists without project.yaml; apply with repair to add the missing files (existing files are kept)`)]);
  }
  const inspection = inspectStateDirectory(root);
  if (inspection.basis !== plan.basis) return failure([createDiagnostic("INIT_PLAN_STALE", `${STATE_DIR_NAME} changed after the plan was made; plan again`)]);
  const normalized = normalizeInitAnswers(plan, answers);
  if (normalized.value === undefined) return failure(normalized.diagnostics);
  const files = [...renderInitFiles(plan, normalized.value)].sort(([a], [b]) => compareUtf8(a, b));

  // Guard every final path before anything is written.
  const guards: Diagnostic[] = [];
  for (const [p, f] of files) guards.push(...guardWrite(root, p, f.kind).diagnostics);
  for (const d of plan.directories) guards.push(...guardDirectory(root, d, INIT_DIRECTORIES.find((x) => x.path === d)?.kind ?? "project-truth").diagnostics);
  if (guards.length > 0) return failure(guards);

  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const runtimeRel = `${STATE_DIR_NAME}/runtime` as RepoPath;
  const stagingRel = `${runtimeRel}/init-${randomBytes(6).toString("hex")}` as RepoPath;
  const stagingAbs = path.join(root, stagingRel);
  let stagingMade = false;
  const rollback = async () => {
    for (const f of [...createdFiles].reverse()) await io.removeFile(f).catch(() => undefined);
    if (stagingMade) await io.removeTree(stagingAbs).catch(() => undefined);
    for (const d of [...createdDirs].reverse()) await io.removeDir(d).catch(() => undefined);
  };
  const mkdir = async (abs: string) => { if (await io.mkdir(abs)) createdDirs.push(abs); };
  try {
    for (const rel of [STATE_DIR_NAME, runtimeRel]) {
      const g = guardDirectory(root, rel as RepoPath, rel === STATE_DIR_NAME ? "project-truth" : "regenerable");
      if (g.value === undefined) { await rollback(); return failure(g.diagnostics); }
      await mkdir(g.value.absolute);
    }
    const staged = guardWrite(root, `${stagingRel}/x`, "regenerable");
    if (staged.value === undefined) { await rollback(); return failure(staged.diagnostics); }
    await io.mkdir(stagingAbs);
    stagingMade = true;
    // Stage the final Truth: the existing Truth files (repair) plus the new ones, then load it with the core loader.
    const stageAbs = (p: string) => path.join(stagingAbs, ...p.split("/"));
    const ensureStageDir = async (p: string) => { await fsp.mkdir(path.dirname(stageAbs(p)), { recursive: true }); };
    for (const p of inspection.existing.filter(isTruthFile)) {
      await ensureStageDir(p);
      await io.copyFile(path.join(root, p), stageAbs(p));
    }
    for (const [p, f] of files) {
      await ensureStageDir(p);
      await io.writeFile(stageAbs(p), f.text);
    }
    const loaded = loadProjectTruth(stagingAbs);
    const created = new Set<string>(files.map(([p]) => p));
    const errors = loaded.diagnostics.filter((d) => d.severity === "error");
    const ours = errors.filter((d) => d.source === undefined || created.has(d.source.path));
    if (loaded.value === undefined || ours.length > 0) {
      await rollback();
      return failure([createDiagnostic("INIT_VALIDATION_FAILED", `The planned Project Truth does not load cleanly: ${(ours.length > 0 ? ours : errors).map((d) => `${d.code} ${d.source?.path ?? ""}`.trim()).join("; ")}`), ...(ours.length > 0 ? ours : errors)]);
    }
    // Commit: directories, then files (project.yaml last: its presence is what makes the project initialized).
    for (const d of plan.directories) await mkdir(path.join(root, d));
    const order = [...files].sort(([a], [b]) => (a === INIT_FILES.project ? 1 : b === INIT_FILES.project ? -1 : compareUtf8(a, b)));
    for (const [p] of order) {
      const target = path.join(root, p);
      await io.place(stageAbs(p), target);
      createdFiles.push(target);
    }
    await io.removeTree(stagingAbs);
    stagingMade = false;
    const final = loadProjectTruth(root);
    const kept = inspection.existing.filter((p) => !created.has(p));
    return success({
      state: "initialized", created: files.map(([p]) => p), directories: plan.directories, kept, openQuestions: openQuestionsOf(plan, normalized.value),
      indexRequired: true, llmCalls: 0, diagnostics: [...final.diagnostics, ...errors.filter((d) => !ours.includes(d))].filter((d, i, all) => all.indexOf(d) === i),
    }, final.diagnostics.filter((d) => d.severity !== "error"));
  } catch (error) {
    await rollback();
    return failure([createDiagnostic("INIT_APPLY_FAILED", `Init could not write ${STATE_DIR_NAME} (${(error as Error).message}); every file and directory it created was removed`)]);
  }
}

