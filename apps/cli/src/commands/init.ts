/**
 * duoctl init (T15): the Existing Project Adoption flow, one domain service per step.
 *
 *   Repository: planInit()  →  Truth: applyInitPlan()  →  Index: indexRepository()  →  Baseline: captureAdoptionBaseline()
 *
 * Every step is reported; a later step failing never reads as success, and running init again
 * continues from the first unfinished step without touching existing Truth. --yes only approves
 * operational confirmations: it never answers a Truth question, accepts a suggestion or chooses the
 * dirty-tree adoption policy.
 */
import {
  applyInitPlan, captureAdoptionBaseline, getAdoptionBaselineStatus, planInit, type InitAnswer, type InitApplyResult, type InitPlan, type InitQuestion,
} from "@duo-director/director";
import { createDiagnostic, type Diagnostic } from "@duo-director/core";
import { indexRepository, inspectIndex, type IndexResult } from "@duo-director/graph";
import { t, type MessageKey } from "../messages.js";
import { EXIT, type Outcome } from "../output.js";
import { diagLines, humanActor, interactive, progress, withRegistry, withWriter, type Env } from "./shared.js";

export interface InitOptions {
  readonly repair: boolean;
  readonly answersFromStdin: boolean;
  readonly baselinePolicy?: "head" | "abort";
}

type StepStatus = "ok" | "existing" | "failed" | "action-required" | "skipped" | "aborted";
interface Step { status: StepStatus; detail?: string }

function parseAnswers(text: string): InitAnswer[] | string {
  try {
    const v = JSON.parse(text) as unknown;
    const list = Array.isArray(v) ? v : (v as { answers?: unknown } | null)?.answers;
    return Array.isArray(list) ? (list as InitAnswer[]) : "expected a JSON array of answers or { \"answers\": [...] }";
  } catch (error) {
    return `answers are not JSON: ${(error as Error).message}`;
  }
}

async function askQuestions(env: Env, questions: readonly InitQuestion[]): Promise<InitAnswer[]> {
  const answers: InitAnswer[] = [];
  for (const q of questions) {
    const label = t(env.locale, `init.question.${q.id}` as MessageKey);
    if (q.id === "project_goal") {
      if (q.suggestedValue !== undefined) {
        env.io.out(t(env.locale, "init.suggested", { source: q.evidence?.[0]?.path ?? "repository", value: q.suggestedValue }));
        const accept = (await env.io.prompt(`${t(env.locale, "init.accept")} `))?.trim().toLowerCase();
        if (accept === "y" || accept === "yes") { answers.push({ question: "project_goal", value: q.suggestedValue, acceptSuggestion: true }); continue; }
      }
      const value = (await env.io.prompt(`${label}: `))?.trim() ?? "";
      if (value !== "") answers.push({ question: "project_goal", value });
    } else if (q.id === "current_milestone") {
      const title = (await env.io.prompt(`${label}: `))?.trim() ?? "";
      if (title !== "") answers.push({ question: "current_milestone", title });
    } else {
      const text = (await env.io.prompt(`${label}: `))?.trim() ?? "";
      if (text !== "") answers.push({ question: "critical_constraints", statements: text.split(";").map((s) => s.trim()).filter((s) => s !== "") });
    }
  }
  return answers;
}

const yes = (v: string | undefined, fallback: boolean) => {
  const a = v?.trim().toLowerCase();
  return a === undefined || a === "" ? fallback : a === "y" || a === "yes";
};

export async function initCommand(env: Env, options: InitOptions): Promise<Outcome> {
  const steps: Record<"repository" | "truth" | "index" | "baseline", Step> = {
    repository: { status: "skipped" }, truth: { status: "skipped" }, index: { status: "skipped" }, baseline: { status: "skipped" },
  };
  const diagnostics: Diagnostic[] = [];
  const human: string[] = [];
  let apply: InitApplyResult | undefined;
  let indexed: IndexResult | undefined;
  let baseline: Record<string, unknown> | undefined;
  const label = (k: keyof typeof steps) => t(env.locale, `init.${k}` as MessageKey);
  const report = (k: keyof typeof steps) => { const s = steps[k]; progress(env, `${label(k).padEnd(10)} ${t(env.locale, `step.${s.status}` as MessageKey)}${s.detail === undefined ? "" : ` · ${s.detail}`}`); };
  // eslint-disable-next-line prefer-const -- finish() reads it before planInit() assigns it
  let plan: InitPlan | undefined;
  const finish = (exitCode: number): Outcome => ({
    command: "init", exitCode, diagnostics, human,
    result: {
      steps,
      ...(plan === undefined ? {} : { plan: { state: plan.state, observed: plan.observed, documents: plan.documents, importCandidates: plan.importCandidates.length, questions: plan.questions, willCreate: plan.willCreate, conflicts: plan.conflicts } }),
      ...(apply === undefined ? {} : { apply }),
      ...(indexed === undefined ? {} : { index: { mode: indexed.mode, fullRebuildReason: indexed.fullRebuildReason ?? null, metrics: indexed.metrics } }),
      ...(baseline === undefined ? {} : { baseline }),
    },
    metric: { status: exitCode === EXIT.OK ? "ok" : exitCode === EXIT.ACTION_REQUIRED ? "action-required" : "failed", ...(indexed === undefined ? {} : { indexMode: indexed.mode, ...(indexed.fullRebuildReason === undefined ? {} : { fullRebuildReason: indexed.fullRebuildReason }) }) },
  });

  // 1. Repository
  const planned = await planInit(env.root);
  if (planned.value === undefined) {
    steps.repository = { status: "failed" };
    diagnostics.push(...planned.diagnostics);
    report("repository");
    human.push(...diagLines(planned.diagnostics));
    return finish(EXIT.ERROR);
  }
  plan = planned.value;
  const o = plan.observed;
  steps.repository = { status: "ok", detail: t(env.locale, "init.observed", { name: o.name.value, languages: o.languages.map((l) => l.language).join(", ") || "-", files: o.files.indexable, branch: o.git.branch ?? "(detached)" }) };
  report("repository");
  const wt = o.workingTree;
  if (wt.dirty) progress(env, t(env.locale, "init.dirty", { staged: wt.counts.staged, unstaged: wt.counts.unstaged, untracked: wt.counts.untracked }));
  if (plan.documents.length > 0) progress(env, t(env.locale, "init.documents", { list: plan.documents.slice(0, 5).map((d) => d.path).join(", ") }));
  if (plan.importCandidates.length > 0) progress(env, t(env.locale, "init.imports", { n: plan.importCandidates.reduce((n, c) => n + c.definitions.length, 0) }));

  // Dirty adoption policy: decided before any persistent write (T15.1). Resuming an initialized project
  // that only lacks its baseline asks here too; nothing is written without the policy.
  const baselineBefore = await getAdoptionBaselineStatus(env.root);
  const needsBaseline = baselineBefore.value?.status === "missing";
  let policy = options.baselinePolicy;
  if (needsBaseline && wt.dirty && policy === undefined && interactive(env)) {
    env.io.err(t(env.locale, "init.dirty.choose"));
    const choice = (await env.io.prompt("> "))?.trim();
    policy = choice === "1" ? "head" : choice === "2" ? "abort" : undefined;
  }
  if (needsBaseline && wt.dirty && policy !== "head") {
    const aborted = policy === "abort";
    steps.baseline = aborted ? { status: "aborted", detail: "ABORT_AND_CLEAN" } : { status: "action-required", detail: "dirty working tree" };
    if (!aborted) diagnostics.push(createDiagnostic("ADOPTION_DIRTY_POLICY_REQUIRED", t("en", "init.dirty.policy-required")));
    human.push(t(env.locale, aborted ? "init.dirty.aborted" : "init.dirty.policy-required"));
    if (aborted) baseline = { status: "aborted" };
    report("baseline");
    return finish(EXIT.ACTION_REQUIRED);
  }

  // 2. Truth
  if (plan.state === "initialized") {
    steps.truth = { status: "existing" };
  } else if (!plan.applicable) {
    steps.truth = { status: "failed" };
    diagnostics.push(...plan.blockers);
    report("truth");
    human.push(...diagLines(plan.blockers));
    return finish(EXIT.ERROR);
  } else {
    let repair = options.repair;
    if (plan.requiresRepair && !repair) {
      if (interactive(env)) repair = env.yes || yes(await env.io.prompt(`${t(env.locale, "init.repair")} `), false);
      else if (env.yes) repair = true;
      if (!repair) {
        steps.truth = { status: "action-required", detail: t(env.locale, "init.repair-required") };
        diagnostics.push(createDiagnostic("INIT_REPAIR_REQUIRED", t("en", "init.repair-required")));
        report("truth");
        return finish(EXIT.ACTION_REQUIRED);
      }
    }
    let answers: InitAnswer[] = [];
    if (options.answersFromStdin) {
      const parsed = parseAnswers(await env.io.readStdin());
      if (typeof parsed === "string") {
        steps.truth = { status: "failed", detail: parsed };
        diagnostics.push(createDiagnostic("CLI_USAGE_INVALID", parsed));
        report("truth");
        return finish(EXIT.ERROR);
      }
      answers = parsed;
    } else if (interactive(env) && !env.yes) {
      answers = await askQuestions(env, plan.questions);
    }
    if (interactive(env) && !env.yes && !yes(await env.io.prompt(`${t(env.locale, "init.apply", { n: plan.willCreate.length })} `), true)) {
      steps.truth = { status: "aborted" };
      human.push(t(env.locale, "init.cancelled"));
      report("truth");
      return finish(EXIT.ERROR);
    }
    const applied = await applyInitPlan(env.root, plan, answers, { repair });
    diagnostics.push(...applied.diagnostics);
    if (applied.value === undefined) {
      steps.truth = { status: "failed" };
      report("truth");
      human.push(...diagLines(applied.diagnostics));
      return finish(EXIT.ERROR);
    }
    apply = applied.value;
    steps.truth = { status: "ok", detail: `${applied.value.created.length} files` };
    if (applied.value.openQuestions.length > 0) human.push(t(env.locale, "init.open", { list: applied.value.openQuestions.join(", ") }));
  }
  report("truth");

  return withRegistry(async (registry) => {
    // 3. Index (the caller's step: applyInitPlan never indexes)
    const indexResult = await withWriter(env.root, async (store) => {
      const inspected = await inspectIndex(env.root, { graph: store, registry });
      if (inspected.value?.status === "current") return "current" as const;
      return indexRepository(env.root, { store, registry });
    });
    if (indexResult === "current") {
      steps.index = { status: "existing" };
    } else if (indexResult.value === undefined) {
      steps.index = { status: "failed" };
      diagnostics.push(...indexResult.diagnostics);
      report("index");
      human.push(...diagLines(indexResult.diagnostics));
      return finish(EXIT.ERROR);
    } else {
      indexed = indexResult.value;
      steps.index = { status: "ok", detail: `${indexed.mode}${indexed.fullRebuildReason === undefined ? "" : ` (${indexed.fullRebuildReason})`} · ${indexed.metrics.files.total} files` };
    }
    report("index");

    // 4. Adoption Baseline (explicit; a dirty tree needs a human policy)
    const status = await getAdoptionBaselineStatus(env.root);
    if (status.value !== undefined && status.value.status !== "missing") {
      baseline = { status: status.value.status, ...(status.value.id === undefined ? {} : { id: status.value.id }), ...(status.value.reason === undefined ? {} : { reason: status.value.reason }) };
      steps.baseline = { status: status.value.status === "incompatible" ? "failed" : "existing", detail: status.value.status };
      report("baseline");
      if (status.value.status === "incompatible") return finish(EXIT.ERROR);
      human.push(t(env.locale, "init.done"));
      return finish(EXIT.OK);
    }
    const captured = await withWriter(env.root, async (graph) => captureAdoptionBaseline(env.root, {
      graph, registry, actor: await humanActor(env.root), clock: () => env.io.now(),
      ...(wt.dirty ? { policy: "HEAD_BASELINE" as const } : {}),
    }));
    diagnostics.push(...captured.diagnostics);
    if (captured.value === undefined) {
      steps.baseline = { status: "failed" };
      report("baseline");
      human.push(...diagLines(captured.diagnostics));
      return finish(EXIT.ERROR);
    }
    if (captured.value.status === "aborted") {
      steps.baseline = { status: "aborted", detail: "ABORT_AND_CLEAN" };
      baseline = { status: "aborted" };
      human.push(t(env.locale, "init.dirty.aborted"));
      report("baseline");
      return finish(EXIT.ACTION_REQUIRED);
    }
    const b = captured.value.baseline;
    baseline = { status: captured.value.status, id: b.id, path: captured.value.path, dirtyAtAdoption: b.workingTree.dirty, findings: b.findings.length, headOid: b.git.headOid };
    steps.baseline = { status: "ok", detail: `${b.git.headOid.slice(0, 12)}${b.workingTree.dirty ? " · dirty at adoption (HEAD_BASELINE)" : ""} · ${b.findings.length} pre-existing findings` };
    report("baseline");
    human.push(t(env.locale, "init.done"));
    return finish(EXIT.OK);
  });
}
