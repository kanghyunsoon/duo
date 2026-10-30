/**
 * duoctl setup (T183, #3, Jira S15P31A106-318): first-time setup of an existing Git repository in one
 * command, built from the services init and install already use.
 *
 *   preflight (read-only)  planInit · getAdoptionBaselineStatus · each agent step's plan()
 *   human choices          dirty-tree baseline policy · Truth questions (--yes never answers them)
 *   one confirmation       of the combined plan; nothing is written before it
 *   apply                  applyInitPlan → indexRepository → captureAdoptionBaseline → agent steps
 *   summary                projectDoctor (read-only) and what is left outside DUO
 *
 * Refused before any write: not a Git repository, no initial commit while a baseline is still needed,
 * conflicting or partial .duo-project, an unreadable baseline, a dirty tree without a policy, any agent
 * step blocker, a cancelled or missing confirmation. A failure after the confirmation keeps what was
 * already written (Project Truth is never deleted) and names the resume command; running setup again
 * continues from the first unfinished step, like init. Index updates of an existing project are
 * regenerable state and, as with duoctl index, need no confirmation. Setup never commits, and never
 * trusts or approves an agent.
 */
import { applyInitPlan, captureAdoptionBaseline, getAdoptionBaselineStatus, planInit, type InitAnswer, type InitApplyResult, type InitPlan } from "@duo-director/director";
import { createDiagnostic, type Diagnostic } from "@duo-director/core";
import { indexRepository, inspectIndex, type IndexResult } from "@duo-director/graph";
import type { DoctorPayload } from "@duo-director/integration";
import { t, type MessageKey } from "../messages.js";
import { EXIT, type Outcome } from "../output.js";
import { doctorPayload, renderDoctor } from "./doctor.js";
import { askQuestions, parseAnswers } from "./init.js";
import { CliFailure, diagLines, humanActor, interactive, progress, withRegistry, withWriter, type Env } from "./shared.js";

export interface SetupOptions {
  readonly repair: boolean;
  readonly answersFromStdin: boolean;
  readonly baselinePolicy?: "head" | "abort";
}

/** What an agent step sees. truthPlanned: Project Truth does not exist yet; this setup creates it before any apply(). */
export interface SetupStepContext {
  readonly env: Env;
  readonly truthPlanned: boolean;
}

export interface SetupStepPlan {
  readonly willCreate: readonly string[];
  readonly willModify: readonly string[];
  /** Any blocker (a conflict, an unavailable launcher) stops setup before the confirmation; nothing is written. */
  readonly blockers: readonly Diagnostic[];
  /** Nothing to change (already connected): needs no confirmation and is not applied. */
  readonly noop: boolean;
  /** Plan lines for humans, already localized, shown before the confirmation. */
  readonly lines: readonly string[];
  /** Machine-readable plan for --json (for example the AgentIntegrationPlan). */
  readonly detail?: unknown;
}

export interface SetupStepResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly lines: readonly string[];
  /** Steps left outside DUO (Codex project trust, Claude Code server approval), already localized. */
  readonly remaining: readonly string[];
  readonly detail?: unknown;
}

/**
 * An optional setup step after Truth, index and baseline: Jira S15P31A106-319 connects Codex and Claude Code
 * through it. plan() must be read-only and is called before the single confirmation, also when the Truth is
 * only planned (truthPlanned). apply() runs after the confirmation; it must undo its own partial writes when
 * it fails (H-94 ownership) and report the failure. Setup then stops and keeps everything before it.
 */
export interface SetupAgentStep {
  readonly id: string;
  plan(context: SetupStepContext): Promise<SetupStepPlan>;
  apply(context: SetupStepContext, plan: SetupStepPlan): Promise<SetupStepResult>;
}

type StepStatus = "ok" | "existing" | "failed" | "action-required" | "skipped" | "aborted";
interface Step { status: StepStatus; detail?: string }
export type SetupStatus = "set-up" | "unchanged" | "blocked" | "action-required" | "confirmation-required" | "cancelled" | "failed";

const yes = (v: string | undefined) => { const a = v?.trim().toLowerCase(); return a === "y" || a === "yes"; };
/** A writer that could not open (lock timeout, unreadable graph) after the confirmation: report it and offer the resume. */
const thrown = (error: unknown): readonly Diagnostic[] => (error instanceof CliFailure ? error.diagnostics : [createDiagnostic("GRAPH_WRITE_REFUSED", error instanceof Error ? error.message : String(error))]);

export async function setupCommand(env: Env, options: SetupOptions, agentSteps: readonly SetupAgentStep[] = []): Promise<Outcome> {
  const L = env.locale;
  const steps: Record<"repository" | "truth" | "index" | "baseline", Step> = {
    repository: { status: "skipped" }, truth: { status: "skipped" }, index: { status: "skipped" }, baseline: { status: "skipped" },
  };
  const agents: Record<string, Step> = Object.fromEntries(agentSteps.map((s) => [s.id, { status: "skipped" }]));
  const diagnostics: Diagnostic[] = [];
  const human: string[] = [];
  const remaining: string[] = [];
  const agentPlans: { readonly step: SetupAgentStep; readonly plan: SetupStepPlan }[] = [];
  const agentResults: Record<string, unknown> = {};
  // eslint-disable-next-line prefer-const -- finish() reads it before planInit() assigns it
  let plan: InitPlan | undefined;
  let apply: InitApplyResult | undefined;
  let indexed: IndexResult | undefined;
  let baseline: Record<string, unknown> | undefined;
  let doctor: DoctorPayload | undefined;
  let resume: string | undefined;
  let policy = options.baselinePolicy;
  let needsBaseline = false;

  const report = (name: string, s: Step) => progress(env, name.padEnd(10) + " " + t(L, ("step." + s.status) as MessageKey) + (s.detail === undefined ? "" : " · " + s.detail));
  const label = (k: keyof typeof steps) => t(L, ("init." + k) as MessageKey);
  const finish = (exitCode: number, status: SetupStatus): Outcome => ({
    command: "setup", exitCode, diagnostics, human,
    result: {
      status, steps: { ...steps, agents },
      ...(plan === undefined ? {} : {
        plan: {
          state: plan.state, observed: plan.observed, questions: plan.questions, willCreate: plan.willCreate, conflicts: plan.conflicts,
          baseline: { required: needsBaseline, policy: needsBaseline && plan.observed.workingTree.dirty ? policy ?? null : null },
          agents: agentPlans.map(({ step, plan: p }) => ({ id: step.id, willCreate: p.willCreate, willModify: p.willModify, noop: p.noop, blockers: p.blockers, ...(p.detail === undefined ? {} : { detail: p.detail }) })),
        },
      }),
      ...(apply === undefined ? {} : { apply }),
      ...(indexed === undefined ? {} : { index: { mode: indexed.mode, fullRebuildReason: indexed.fullRebuildReason ?? null, metrics: indexed.metrics } }),
      ...(baseline === undefined ? {} : { baseline }),
      ...(Object.keys(agentResults).length === 0 ? {} : { agents: agentResults }),
      ...(resume === undefined ? {} : { resume }),
      remaining,
      ...(doctor === undefined ? {} : { doctor }),
    },
    metric: { status, ...(indexed === undefined ? {} : { indexMode: indexed.mode, ...(indexed.fullRebuildReason === undefined ? {} : { fullRebuildReason: indexed.fullRebuildReason }) }) },
  });
  /** After the confirmation: keep what was written and say how to continue. */
  const stopped = (step: string): Outcome => {
    resume = "duoctl setup" + (needsBaseline && plan?.observed.workingTree.dirty === true && steps.baseline.status !== "ok" ? " --baseline-policy head" : "");
    human.push(t(L, "setup.resume", { step, command: resume }));
    return finish(EXIT.ERROR, "failed");
  };

  // ---- 1. Preflight: read-only ----
  const planned = await planInit(env.root);
  if (planned.value === undefined) {
    steps.repository = { status: "failed" };
    diagnostics.push(...planned.diagnostics);
    report(label("repository"), steps.repository);
    human.push(...diagLines(planned.diagnostics));
    return finish(EXIT.ERROR, "blocked");
  }
  plan = planned.value;
  const o = plan.observed;
  const wt = o.workingTree;
  steps.repository = { status: "ok", detail: t(L, "init.observed", { name: o.name.value, languages: o.languages.map((l) => l.language).join(", ") || "-", files: o.files.indexable, branch: o.git.branch ?? "(detached)" }) };
  report(label("repository"), steps.repository);
  if (wt.dirty) progress(env, t(L, "init.dirty", { staged: wt.counts.staged, unstaged: wt.counts.unstaged, untracked: wt.counts.untracked }));

  const truthPlanned = plan.state !== "initialized";
  if (truthPlanned && !plan.applicable) {
    steps.truth = { status: "failed" };
    diagnostics.push(...plan.blockers);
    report(label("truth"), steps.truth);
    human.push(...diagLines(plan.blockers), t(L, "setup.blocked"));
    return finish(EXIT.ERROR, "blocked");
  }
  if (truthPlanned && plan.requiresRepair && !options.repair) {
    steps.truth = { status: "action-required", detail: "repair" };
    diagnostics.push(createDiagnostic("INIT_REPAIR_REQUIRED", t("en", "setup.repair-required")));
    report(label("truth"), steps.truth);
    human.push(t(L, "setup.repair-required"));
    return finish(EXIT.ACTION_REQUIRED, "action-required");
  }

  const baselineBefore = await getAdoptionBaselineStatus(env.root);
  if (baselineBefore.value === undefined) {
    steps.baseline = { status: "failed" };
    diagnostics.push(...baselineBefore.diagnostics);
    report(label("baseline"), steps.baseline);
    human.push(...diagLines(baselineBefore.diagnostics), t(L, "setup.blocked"));
    return finish(EXIT.ERROR, "blocked");
  }
  if (baselineBefore.value.status === "incompatible") {
    const reason = baselineBefore.value.reason ?? "incompatible";
    steps.baseline = { status: "failed", detail: "incompatible" };
    baseline = { status: "incompatible", reason };
    diagnostics.push(createDiagnostic("ADOPTION_BASELINE_EXISTS", t("en", "setup.baseline-unreadable", { reason })));
    report(label("baseline"), steps.baseline);
    human.push(t(L, "setup.baseline-unreadable", { reason }));
    return finish(EXIT.ERROR, "blocked");
  }
  needsBaseline = baselineBefore.value.status === "missing";
  // C214: an unborn repository has no commit to baseline. Refuse here, before any question or write.
  if (needsBaseline && o.git.unborn) {
    steps.baseline = { status: "action-required", detail: "no initial commit" };
    diagnostics.push(createDiagnostic("ADOPTION_HEAD_REQUIRED", t("en", "setup.unborn")));
    report(label("baseline"), steps.baseline);
    human.push(t(L, "setup.unborn"));
    return finish(EXIT.ACTION_REQUIRED, "action-required");
  }

  const context = { env, truthPlanned };
  for (const step of agentSteps) agentPlans.push({ step, plan: await step.plan(context) });
  const blocked = agentPlans.filter(({ plan: p }) => p.blockers.length > 0);
  if (blocked.length > 0) {
    for (const { step, plan: p } of blocked) {
      agents[step.id] = { status: "action-required" };
      diagnostics.push(...p.blockers);
      report(step.id, agents[step.id] as Step);
      human.push(...p.lines, ...diagLines(p.blockers));
    }
    human.push(t(L, "setup.blocked"));
    return finish(EXIT.ACTION_REQUIRED, "blocked");
  }

  // ---- 2. Human choices: decided before anything is written ----
  if (needsBaseline && wt.dirty && policy === undefined && interactive(env)) {
    env.io.err(t(L, "init.dirty.choose"));
    const choice = (await env.io.prompt("> "))?.trim();
    policy = choice === "1" ? "head" : choice === "2" ? "abort" : undefined;
  }
  if (needsBaseline && wt.dirty && policy !== "head") {
    const aborted = policy === "abort";
    steps.baseline = aborted ? { status: "aborted", detail: "ABORT_AND_CLEAN" } : { status: "action-required", detail: "dirty working tree" };
    if (aborted) baseline = { status: "aborted" };
    else diagnostics.push(createDiagnostic("ADOPTION_DIRTY_POLICY_REQUIRED", t("en", "setup.dirty.policy-required")));
    report(label("baseline"), steps.baseline);
    human.push(t(L, aborted ? "setup.dirty.aborted" : "setup.dirty.policy-required"));
    return finish(EXIT.ACTION_REQUIRED, "action-required");
  }

  let answers: InitAnswer[] = [];
  if (truthPlanned) {
    if (options.answersFromStdin) {
      const parsed = parseAnswers(await env.io.readStdin());
      if (typeof parsed === "string") {
        steps.truth = { status: "failed", detail: parsed };
        diagnostics.push(createDiagnostic("CLI_USAGE_INVALID", parsed));
        report(label("truth"), steps.truth);
        return finish(EXIT.ERROR, "failed");
      }
      answers = parsed;
    } else if (interactive(env) && !env.yes) {
      answers = await askQuestions(env, plan.questions);
    }
  }

  // ---- 3. One plan, one confirmation ----
  const writes = truthPlanned || needsBaseline || agentPlans.some(({ plan: p }) => !p.noop);
  if (writes) {
    const head = (o.git.headOid ?? "").slice(0, 12);
    // The questions are answered by now: list the files apply will create with these answers.
    const answered = new Set(answers.map((a) => a.question));
    const creates = plan.willCreate.filter((f) => f.when === "always" || (f.question !== undefined && answered.has(f.question)));
    progress(env, t(L, "setup.plan.title"));
    progress(env, truthPlanned
      ? t(L, "setup.plan.truth.create", { n: creates.length, list: creates.map((f) => f.path).join(", ") })
      : t(L, "setup.plan.truth.existing"));
    progress(env, t(L, truthPlanned ? "setup.plan.index.build" : "setup.plan.index.update"));
    progress(env, needsBaseline ? t(L, wt.dirty ? "setup.plan.baseline.capture-dirty" : "setup.plan.baseline.capture", { head }) : t(L, "setup.plan.baseline.existing"));
    if (agentSteps.length === 0) progress(env, t(L, "setup.plan.agents.none"));
    for (const { plan: p } of agentPlans) for (const line of p.lines) progress(env, line);
    if (!env.yes) {
      if (!interactive(env)) {
        human.push(t(L, "setup.confirm-required"));
        return finish(EXIT.ACTION_REQUIRED, "confirmation-required");
      }
      if (!yes(await env.io.prompt(t(L, "setup.confirm") + " "))) {
        human.push(t(L, "setup.cancelled"));
        return finish(EXIT.ERROR, "cancelled");
      }
    }
  }

  // ---- 4. Apply: Truth → index → baseline → agent steps ----
  if (truthPlanned) {
    const applied = await applyInitPlan(env.root, plan, answers, { repair: options.repair });
    diagnostics.push(...applied.diagnostics);
    if (applied.value === undefined) {
      // applyInitPlan removes what it created when it fails (INIT_APPLY_FAILED): nothing new is left.
      steps.truth = { status: "failed" };
      report(label("truth"), steps.truth);
      human.push(...diagLines(applied.diagnostics));
      return stopped(label("truth"));
    }
    apply = applied.value;
    steps.truth = { status: "ok", detail: applied.value.created.length + " files" };
    if (applied.value.openQuestions.length > 0) human.push(t(L, "init.open", { list: applied.value.openQuestions.join(", ") }));
    const recorded = new Set(answers.flatMap((a) => (a.question === "critical_constraints" ? a.statements.map((s) => s.trim()).filter((s) => s !== "") : [])));
    if (recorded.size > 0) human.push(t(L, "init.constraints-unchecked", { n: recorded.size }));
  } else {
    steps.truth = { status: "existing" };
  }
  report(label("truth"), steps.truth);

  return withRegistry(async (registry) => {
    let indexResult;
    try {
      indexResult = await withWriter(env.root, async (store) => {
        const inspected = await inspectIndex(env.root, { graph: store, registry });
        if (inspected.value?.status === "current") return "current" as const;
        return indexRepository(env.root, { store, registry });
      });
    } catch (error) {
      indexResult = { value: undefined, diagnostics: thrown(error) };
    }
    if (indexResult === "current") {
      steps.index = { status: "existing" };
    } else if (indexResult.value === undefined) {
      steps.index = { status: "failed" };
      diagnostics.push(...indexResult.diagnostics);
      report(label("index"), steps.index);
      human.push(...diagLines(indexResult.diagnostics));
      return stopped(label("index"));
    } else {
      indexed = indexResult.value;
      steps.index = { status: "ok", detail: indexed.mode + (indexed.fullRebuildReason === undefined ? "" : " (" + indexed.fullRebuildReason + ")") + " · " + indexed.metrics.files.total + " files" };
    }
    report(label("index"), steps.index);

    if (needsBaseline) {
      let captured;
      try {
        captured = await withWriter(env.root, async (graph) => captureAdoptionBaseline(env.root, {
          graph, registry, actor: await humanActor(env.root), clock: () => env.io.now(),
          ...(wt.dirty ? { policy: "HEAD_BASELINE" as const } : {}),
        }));
      } catch (error) {
        captured = { value: undefined, diagnostics: thrown(error) };
      }
      diagnostics.push(...captured.diagnostics);
      if (captured.value === undefined || captured.value.status === "aborted") {
        steps.baseline = { status: "failed" };
        report(label("baseline"), steps.baseline);
        human.push(...diagLines(captured.diagnostics));
        return stopped(label("baseline"));
      }
      const b = captured.value.baseline;
      baseline = { status: captured.value.status, id: b.id, path: captured.value.path, dirtyAtAdoption: b.workingTree.dirty, findings: b.findings.length, headOid: b.git.headOid };
      steps.baseline = { status: "ok", detail: b.git.headOid.slice(0, 12) + (b.workingTree.dirty ? " · dirty at adoption (HEAD_BASELINE)" : "") + " · " + b.findings.length + " pre-existing findings" };
    } else {
      steps.baseline = { status: "existing" };
    }
    report(label("baseline"), steps.baseline);

    for (const { step, plan: p } of agentPlans) {
      if (p.noop) { agents[step.id] = { status: "existing" }; report(step.id, agents[step.id] as Step); continue; }
      let result: SetupStepResult;
      try {
        result = await step.apply(context, p);
      } catch (error) {
        // A step that throws still gets the resume path; what it wrote is its own to undo (H-94).
        result = { ok: false, diagnostics: [createDiagnostic("AGENT_VERIFY_FAILED", step.id + " setup step failed: " + (error instanceof Error ? error.message : String(error)))], lines: [], remaining: [] };
      }
      diagnostics.push(...result.diagnostics);
      if (result.detail !== undefined) agentResults[step.id] = result.detail;
      agents[step.id] = { status: result.ok ? "ok" : "failed" };
      report(step.id, agents[step.id] as Step);
      human.push(...result.lines);
      if (!result.ok) {
        human.push(...diagLines(result.diagnostics));
        return stopped(step.id);
      }
      remaining.push(...result.remaining);
    }

    // ---- 5. Summary: the read-only doctor and what is left outside DUO ----
    doctor = await doctorPayload(env);
    human.push(t(L, writes ? "setup.done" : "setup.unchanged"), ...renderDoctor(L, doctor));
    if (writes) human.push("", t(L, "setup.commit"));
    if (remaining.length > 0) human.push("", t(L, "setup.remaining"), ...remaining.map((line) => "  " + line));
    return finish(doctor.overall === "action-required" ? EXIT.ACTION_REQUIRED : EXIT.OK, writes ? "set-up" : "unchanged");
  });
}
