/**
 * DecisionService (TASK-009, ADR-013): the one place where Decision lifecycle files are written.
 * "AI may propose. Human confirms." Agents and the system create proposals; only a human confirms
 * or rejects. A confirmed Decision's content is never rewritten: a change is a new proposal that
 * supersedes it. Files are the Source of Truth; the Graph learns about a confirmed Decision at the
 * next index run (indexRequired), never from here.
 *
 * Every mutating operation runs under a repository lock (.duo-project/runtime/locks/decisions.lock,
 * created exclusively; a lock of a dead local process is broken). Under the lock it first repairs
 * what an interrupted confirm left behind, then acts. A confirm commits by creating the new
 * decisions/D-###.yaml exclusively (it records the proposal ID); removing the proposal and marking
 * a superseded Decision follow and are finished by the next operation if they fail.
 */
import os from "node:os";
import { createDiagnostic, failure, success, type Diagnostic, type ParseResult } from "../diagnostics.js";
import { parseDecisionFile, parseProposalFile } from "../domain/files.js";
import type { Decision, ProjectTruth, Proposal } from "../domain/model.js";
import { PROPOSAL_ID_PATTERN } from "../ids.js";
import { loadProjectTruth } from "../loader/project.js";
import type { RepoPath } from "../paths.js";
import { ACTOR_KINDS, type ProposalData } from "../schema/schemas.js";
import { parseYaml, setYamlTopLevel, stringifyYaml } from "../source/yaml.js";
import { analyzeTrace } from "../trace/trace.js";
import { decisionLockDigest, definitionDigest, truthDigest, verifyDecisionLock, type LockVerification } from "./digest.js";
import {
  DECISION_LOCK_PATH, DECISIONS_DIR, decisionPath, guardDecisionWrite, nodeDecisionFileSystem, proposalPath, PROPOSALS_DIR,
  type DecisionActor, type DecisionFileSystem, type DecisionWriteTarget,
} from "./files.js";
import { nextDecisionId, nextProposalId } from "./ids.js";
import { listDecisionProposals } from "./read-model.js";

/** The only confirmed-state value written by DUO; used by confirm alone (AC-009-05). */
const CONFIRMED = "confirmed";
const DECISION_ID = /^D-\d+$/;

/** What the actor may do. Human identity is given by the caller, never inferred. */
export const DECISION_PERMISSIONS = {
  propose: ["human", "agent", "system"],
  confirm: ["human"],
  reject: ["human"],
} as const satisfies Record<string, readonly (typeof ACTOR_KINDS)[number][]>;

export type ProposalInput = Pick<ProposalData, "title" | "question" | "answer">
  & Partial<Pick<ProposalData, "kind" | "rationale" | "governs" | "forbids" | "enforcement" | "supersedes" | "evidence" | "source" | "extensions">>;

export interface StaleInfo {
  /** Project Truth changed since the proposal was made. */
  readonly truthChanged: boolean;
  /** Referenced definitions (governed Requirements, superseded Decision) whose text changed or that are gone. */
  readonly changedRefs: readonly string[];
}

export interface ProposeResult { readonly proposalId: string; readonly path: RepoPath; readonly indexRequired: false; readonly repaired: readonly string[] }
export interface ConfirmResult {
  readonly decisionId: string;
  readonly path: RepoPath;
  /** The proposal or Decision that was confirmed. */
  readonly from: string;
  readonly supersedes?: string;
  readonly stale?: StaleInfo;
  /** The Graph reflects the Decision after the next index run. */
  readonly indexRequired: true;
  readonly repaired: readonly string[];
}
export interface RejectResult { readonly proposalId: string; readonly path: RepoPath; readonly indexRequired: false; readonly repaired: readonly string[] }

export interface DecisionServiceOptions {
  readonly root: string;
  /** Injectable clock for timestamps (never used as an identity). */
  readonly clock?: () => Date;
  readonly fs?: DecisionFileSystem;
  /** How long to wait for the repository decision lock. Default 5000 ms. */
  readonly lockTimeoutMs?: number;
}

export interface DecisionService {
  propose(actor: DecisionActor, input: ProposalInput): Promise<ParseResult<ProposeResult>>;
  /** Confirms a proposal (P-...) or a YAML Decision that is proposed or confirmed without a lock (ADR-013). */
  confirm(actor: DecisionActor, id: string): Promise<ParseResult<ConfirmResult>>;
  reject(actor: DecisionActor, proposalId: string, reason?: string): Promise<ParseResult<RejectResult>>;
  /** Finishes what an interrupted confirm left behind (also done at the start of every operation). */
  repair(): Promise<ParseResult<{ readonly repaired: readonly string[] }>>;
  /** Read-only lock check of one Decision. */
  verifyLock(decisionId: string): ParseResult<LockVerification>;
}

const SYSTEM: DecisionActor = { kind: "system", name: "duo" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idTokens = (message: string) => message.split(/[^A-Za-z0-9-]+/u);
const TRACE_ERRORS = new Set(["BROKEN_REFERENCE", "REFERENCE_TYPE_MISMATCH", "DUPLICATE_ID", "DECISION_SUPERSEDES_SELF", "DECISION_SUPERSEDE_CYCLE"]);
const yaml = stringifyYaml;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createDecisionService(options: DecisionServiceOptions): DecisionService {
  const root = options.root;
  const fs = options.fs ?? nodeDecisionFileSystem;
  const clock = options.clock ?? (() => new Date());
  const now = () => clock().toISOString();

  const forbidden = (actor: DecisionActor, op: keyof typeof DECISION_PERMISSIONS): Diagnostic[] => {
    if (!(ACTOR_KINDS as readonly string[]).includes(actor.kind) || actor.name.trim() === "") {
      return [createDiagnostic("DECISION_ACTOR_FORBIDDEN", "An actor needs a kind (human, agent, system) and a name")];
    }
    return (DECISION_PERMISSIONS[op] as readonly string[]).includes(actor.kind)
      ? []
      : [createDiagnostic("DECISION_ACTOR_FORBIDDEN", `${actor.kind} "${actor.name}" cannot ${op}; AI may propose, a human confirms`)];
  };

  const guard = (actor: DecisionActor, repoPath: string, target: DecisionWriteTarget) => guardDecisionWrite(root, actor, repoPath, target);

  async function withLock<T>(fn: () => Promise<ParseResult<T>>): Promise<ParseResult<T>> {
    const lock = guard(SYSTEM, DECISION_LOCK_PATH, "lock");
    if (lock.value === undefined) return failure(lock.diagnostics);
    const file = lock.value.absolute;
    const deadline = Date.now() + (options.lockTimeoutMs ?? 5000);
    for (;;) {
      if (await fs.createExclusive(file, JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: now() }))) break;
      let owner: { pid?: unknown; host?: unknown } | undefined;
      try {
        owner = JSON.parse((await fs.readText(file)) ?? "null") as typeof owner;
      } catch {
        owner = undefined;
      }
      if (owner === null) continue; // released meanwhile
      if (typeof owner?.pid === "number" && owner.host === os.hostname() && !alive(owner.pid)) {
        await fs.remove(file); // lock of a local process that no longer exists
        continue;
      }
      if (Date.now() >= deadline) return failure([createDiagnostic("DECISION_LOCK_BUSY", `${DECISION_LOCK_PATH} is held by another process`)]);
      await sleep(20);
    }
    try {
      return await fn();
    } finally {
      await fs.remove(file);
    }
  }

  function load(): ParseResult<ProjectTruth> {
    const loaded = loadProjectTruth(root);
    return loaded.value === undefined ? failure(loaded.diagnostics) : success(loaded.value.truth, loaded.diagnostics);
  }

  const isServiceFile = (d: Decision) => d.location.path === decisionPath(d.id);

  /** Errors the core trace rules report for id once the given definitions replace their namesakes. */
  function traceErrors(truth: ProjectTruth, id: string, path: string, change: { decision?: Decision; proposal?: Proposal }): Diagnostic[] {
    const decisions = change.decision === undefined ? truth.decisions : [...truth.decisions.filter((d) => d.location.path !== path), change.decision];
    const proposals = change.proposal === undefined ? truth.proposals : [...truth.proposals.filter((p) => p.location.path !== path), change.proposal];
    const { diagnostics } = analyzeTrace({ ...truth, decisions, proposals, references: truth.config.references });
    return diagnostics.filter((d) => d.severity === "error" && TRACE_ERRORS.has(d.code) && (d.source?.path === path || idTokens(d.message).includes(id)));
  }

  /** Changes a YAML file in place, keeping comments and layout; refuses changes outside allowedKeys. */
  async function updateInPlace(actor: DecisionActor, repoPath: string, target: DecisionWriteTarget, allowed: ReadonlySet<string>, values: Record<string, unknown>): Promise<Diagnostic[]> {
    const g = guard(actor, repoPath, target);
    if (g.value === undefined) return [...g.diagnostics];
    const text = await fs.readText(g.value.absolute);
    if (text === undefined) return [createDiagnostic("FILE_READ_ERROR", `${repoPath} is missing`, { path: repoPath })];
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) return [createDiagnostic("DECISION_LOCKED", `${repoPath}: "${key}" is not a lifecycle field; confirmed content is not changed by DUO`, { path: repoPath })];
    }
    const next = setYamlTopLevel(text, values);
    const parsed = target === "proposal" ? parseProposalFile(repoPath, next) : parseDecisionFile(repoPath, next);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) return errors;
    await fs.writeAtomic(g.value.absolute, next);
    return [];
  }

  /** Finishes an interrupted confirm: drop proposals that already became Decisions, mark superseded targets. */
  async function repairWith(truth: ProjectTruth): Promise<{ repaired: string[]; diagnostics: Diagnostic[] }> {
    const repaired: string[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const d of truth.decisions) {
      if (d.proposalId === undefined || !isServiceFile(d)) continue;
      const pending = truth.proposals.find((p) => p.id === d.proposalId);
      if (pending !== undefined) {
        const g = guard({ kind: "human", name: d.confirmedBy ?? "duo" }, pending.location.path, "proposal");
        if (g.value !== undefined) {
          await fs.remove(g.value.absolute);
          repaired.push(`removed ${pending.location.path} (confirmed as ${d.id})`);
        }
      }
      if (d.state === CONFIRMED && d.supersedes !== null) {
        const target = truth.decisions.find((t) => t.id === d.supersedes);
        if (target !== undefined && target.state === CONFIRMED && isServiceFile(target)) {
          const errors = await updateInPlace({ kind: "human", name: d.confirmedBy ?? "duo" }, target.location.path, "decision",
            new Set(["state", "superseded_by"]), { state: "superseded", superseded_by: d.id });
          diagnostics.push(...errors);
          if (errors.length === 0) repaired.push(`marked ${target.id} superseded by ${d.id}`);
        }
      }
    }
    return { repaired, diagnostics };
  }

  /** Loads the truth and repairs it (under the lock). */
  async function prepare(): Promise<ParseResult<{ truth: ProjectTruth; repaired: string[] }>> {
    let loaded = load();
    if (loaded.value === undefined) return failure(loaded.diagnostics);
    const fixed = await repairWith(loaded.value);
    if (fixed.repaired.length > 0) {
      loaded = load();
      if (loaded.value === undefined) return failure(loaded.diagnostics);
    }
    return success({ truth: loaded.value, repaired: fixed.repaired }, fixed.diagnostics);
  }

  /** Digests of referenced definitions' exact source slices. A location that does not slice is a producer bug and fails. */
  function refDigests(truth: ProjectTruth, ids: readonly string[]): ParseResult<{ id: string; digest: string }[]> {
    const out: { id: string; digest: string }[] = [];
    for (const id of [...new Set(ids)].sort()) {
      const def = [...truth.requirements, ...truth.decisions].find((d) => d.id === id);
      if (def === undefined) continue;
      const digest = definitionDigest(root, def.location);
      if (digest.value === undefined) return failure(digest.diagnostics);
      out.push({ id, digest: digest.value });
    }
    return success(out);
  }

  function staleness(truth: ProjectTruth, proposal: Proposal): StaleInfo | undefined {
    if (proposal.basedOn === undefined) return undefined;
    const current = new Map((refDigests(truth, proposal.basedOn.refs.map((r) => r.id)).value ?? []).map((r) => [r.id, r.digest]));
    const changedRefs = proposal.basedOn.refs.filter((r) => current.get(r.id) !== r.digest).map((r) => r.id);
    const truthChanged = truthDigest(root, truth) !== proposal.basedOn.truthDigest;
    return truthChanged || changedRefs.length > 0 ? { truthChanged, changedRefs } : undefined;
  }

  async function allocate(prefix: "D" | "P", truth: ProjectTruth): Promise<string> {
    const names = [...await fs.list(`${root}/${DECISIONS_DIR}`), ...await fs.list(`${root}/${PROPOSALS_DIR}`)].map((n) => n.replace(/\.ya?ml$/u, ""));
    if (prefix === "D") return nextDecisionId([...truth.decisions.map((d) => d.id), ...names]);
    return nextProposalId([...truth.proposals.map((p) => p.id), ...truth.decisions.flatMap((d) => (d.proposalId === undefined ? [] : [d.proposalId])), ...names]);
  }

  /** Creates a new file under a fresh ID; if another writer took the ID meanwhile, takes the next one. */
  async function createWithNewId(actor: DecisionActor, prefix: "D" | "P", truth: ProjectTruth, render: (id: string) => string): Promise<ParseResult<{ id: string; path: RepoPath }>> {
    const taken: string[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const base = await allocate(prefix, truth);
      // Normally base is free (allocate() sees every existing file); after a lost race take the next free number.
      const chosen = !taken.includes(base) ? base : prefix === "D" ? nextDecisionId(taken) : nextProposalId(taken);
      const repoPath = prefix === "D" ? decisionPath(chosen) : proposalPath(chosen);
      const g = guard(actor, repoPath, prefix === "D" ? "decision" : "proposal");
      if (g.value === undefined) return failure(g.diagnostics);
      let created: boolean;
      try {
        created = await fs.createExclusive(g.value.absolute, render(chosen));
      } catch (error) {
        return failure([createDiagnostic("FILE_WRITE_ERROR", `Cannot create ${g.value.path}: ${(error as Error).message}; nothing was confirmed`, { path: g.value.path })]);
      }
      if (created) return success({ id: chosen, path: g.value.path });
      taken.push(chosen);
    }
    return failure([createDiagnostic("DECISION_LOCK_BUSY", `Could not allocate a free ${prefix} ID`)]);
  }

  return {
    async propose(actor, input) {
      const denied = forbidden(actor, "propose");
      if (denied.length > 0) return failure(denied);
      return withLock(async () => {
        const prepared = await prepare();
        if (prepared.value === undefined) return failure(prepared.diagnostics);
        const { truth, repaired } = prepared.value;
        const digests = refDigests(truth, [...(input.governs?.requirements ?? []), ...(input.supersedes ? [input.supersedes] : [])]);
        if (digests.value === undefined) return failure(digests.diagnostics);
        const refs = digests.value;
        const render = (id: string) => yaml(defined({
          id, title: input.title, kind: input.kind, state: "proposed", question: input.question, answer: input.answer, rationale: input.rationale,
          governs: input.governs, forbids: input.forbids, enforcement: input.enforcement, supersedes: input.supersedes, evidence: input.evidence,
          source: input.source, extensions: input.extensions,
          proposed_by: actor.name, proposed_by_kind: actor.kind, proposed_at: now(),
          based_on: defined({ truth_digest: truthDigest(root, truth), refs: refs.length === 0 ? undefined : refs }),
        }));
        // Validate with the same schema and trace rules as the loader before writing anything.
        const probeId = await allocate("P", truth);
        const probePath = proposalPath(probeId);
        const parsed = parseProposalFile(probePath, render(probeId));
        const schemaErrors = parsed.diagnostics.filter((d) => d.severity === "error");
        const problems = parsed.value === undefined ? schemaErrors : [...schemaErrors, ...traceErrors(truth, probeId, probePath, { proposal: parsed.value })];
        if (input.supersedes) {
          const target = truth.decisions.find((d) => d.id === input.supersedes);
          if (target !== undefined && target.state !== CONFIRMED) {
            problems.push(createDiagnostic("DECISION_SUPERSEDE_TARGET_INVALID", `${target.id} is ${target.state}; only a confirmed Decision can be superseded`, target.location));
          }
        }
        if (problems.length > 0) return failure([createDiagnostic("PROPOSAL_INVALID", "The proposal was not written"), ...problems]);
        const created = await createWithNewId(actor, "P", truth, render);
        if (created.value === undefined) return failure(created.diagnostics);
        return success({ proposalId: created.value.id, path: created.value.path, indexRequired: false as const, repaired }, prepared.diagnostics);
      });
    },

    async confirm(actor, id) {
      const denied = forbidden(actor, "confirm");
      if (denied.length > 0) return failure(denied);
      if (!PROPOSAL_ID_PATTERN.test(id) && !DECISION_ID.test(id)) return failure([createDiagnostic("INVALID_ID", `"${id}" is not a proposal or Decision ID`)]);
      return withLock(async () => {
        const prepared = await prepare();
        if (prepared.value === undefined) return failure(prepared.diagnostics);
        const { truth, repaired } = prepared.value;
        const warnings: Diagnostic[] = [...prepared.diagnostics];
        return DECISION_ID.test(id) ? confirmDecision(actor, id, truth, repaired, warnings) : confirmProposal(actor, id, truth, repaired, warnings);
      });
    },

    async reject(actor, proposalId, reason) {
      const denied = forbidden(actor, "reject");
      if (denied.length > 0) return failure(denied);
      if (DECISION_ID.test(proposalId)) return failure([createDiagnostic("DECISION_LOCKED", `${proposalId} is a Decision; reject applies to proposals, a confirmed Decision is superseded`)]);
      if (!PROPOSAL_ID_PATTERN.test(proposalId)) return failure([createDiagnostic("INVALID_ID", `"${proposalId}" is not a proposal ID`)]);
      return withLock(async () => {
        const prepared = await prepare();
        if (prepared.value === undefined) return failure(prepared.diagnostics);
        const { truth, repaired } = prepared.value;
        const entry = listDecisionProposals(truth).find((p) => p.id === proposalId);
        if (entry === undefined) return failure([createDiagnostic("PROPOSAL_NOT_FOUND", `No proposal ${proposalId}`)]);
        if (entry.status !== "pending") {
          return failure([createDiagnostic("PROPOSAL_NOT_PENDING", entry.decisionId === undefined ? `${proposalId} is ${entry.status}` : `${proposalId} was confirmed as ${entry.decisionId}`, entry.proposal.location)]);
        }
        const proposal = entry.proposal;
        const errors = await updateInPlace(actor, proposal.location.path, "proposal", new Set(["state", "rejected_at", "rejected_by", "reason"]),
          { state: "rejected", rejected_at: now(), rejected_by: actor.name, reason: reason === undefined || reason.trim() === "" ? undefined : reason });
        if (errors.length > 0) return failure(errors);
        return success({ proposalId, path: proposal.location.path as RepoPath, indexRequired: false as const, repaired }, prepared.diagnostics);
      });
    },

    async repair() {
      return withLock(async () => {
        const prepared = await prepare();
        return prepared.value === undefined ? failure(prepared.diagnostics) : success({ repaired: prepared.value.repaired }, prepared.diagnostics);
      });
    },

    verifyLock(decisionId) {
      const loaded = load();
      if (loaded.value === undefined) return failure(loaded.diagnostics);
      const d = loaded.value.decisions.find((x) => x.id === decisionId);
      if (d === undefined) return failure([createDiagnostic("PROPOSAL_NOT_FOUND", `No Decision ${decisionId}`)]);
      const r = verifyDecisionLock(d);
      return success(r.value, r.diagnostics);
    },
  };

  async function confirmProposal(actor: DecisionActor, id: string, truth: ProjectTruth, repaired: string[], warnings: Diagnostic[]): Promise<ParseResult<ConfirmResult>> {
    const done = truth.decisions.find((d) => d.proposalId === id);
    if (done !== undefined) return failure([createDiagnostic("PROPOSAL_NOT_PENDING", `${id} was already confirmed as ${done.id}`)]);
    const entry = listDecisionProposals(truth).find((p) => p.id === id);
    if (entry === undefined) return failure([createDiagnostic("PROPOSAL_NOT_FOUND", `No proposal ${id}`)]);
    if (entry.status !== "pending") return failure([createDiagnostic("PROPOSAL_NOT_PENDING", `${id} is ${entry.status}`, entry.proposal.location)]);
    const proposal = entry.proposal;
    const stale = staleness(truth, proposal);
    if (stale !== undefined) {
      warnings.push(createDiagnostic("PROPOSAL_STALE",
        `${id} was made on an older Project Truth${stale.changedRefs.length > 0 ? ` (changed: ${stale.changedRefs.join(", ")})` : ""}; confirmed anyway`, proposal.location));
    }
    const text = await fs.readText(`${root}/${proposal.location.path}`);
    if (text === undefined) return failure([createDiagnostic("PROPOSAL_NOT_FOUND", `${proposal.location.path} is missing`)]);
    const data = (parseYaml({ path: proposal.location.path, text }).value?.data ?? {}) as Record<string, unknown>;
    const target = proposal.supersedes === null ? undefined : truth.decisions.find((d) => d.id === proposal.supersedes);
    if (proposal.supersedes !== null) {
      if (target === undefined) return failure([createDiagnostic("BROKEN_REFERENCE", `${id} supersedes ${proposal.supersedes}, which does not exist`, proposal.location)]);
      if (!isServiceFile(target)) return failure([createDiagnostic("DECISION_TARGET_UNSUPPORTED", `${target.id} is not a decisions/D-###.yaml file; DUO does not rewrite it`, target.location)]);
      if (target.state !== CONFIRMED) return failure([createDiagnostic("DECISION_SUPERSEDE_TARGET_INVALID", `${target.id} is ${target.state}; only a confirmed Decision can be superseded`, target.location)]);
    }
    const confirmedAt = now();
    const content = (decisionId: string, digest?: string) => yaml(defined({
      id: decisionId, title: data.title, kind: data.kind, state: CONFIRMED, question: data.question, answer: data.answer, rationale: data.rationale,
      owner: "human", governs: data.governs, forbids: data.forbids, enforcement: data.enforcement, supersedes: data.supersedes,
      evidence: data.evidence, source: data.source, extensions: data.extensions,
      proposal: id, proposed_by: data.proposed_by, proposed_by_kind: data.proposed_by_kind, proposed_at: data.proposed_at,
      confirmed_at: confirmedAt, confirmed_by: actor.name, lock: digest === undefined ? undefined : { digest },
    }));
    const render = (decisionId: string) => {
      const draft = parseDecisionFile(decisionPath(decisionId), content(decisionId));
      return content(decisionId, draft.value === undefined ? undefined : decisionLockDigest(draft.value));
    };
    // Validate against the loader's schema and the core trace rules (self, missing target, cycle, duplicate).
    const probeId = await allocate("D", truth);
    const probe = parseDecisionFile(decisionPath(probeId), render(probeId));
    const problems = probe.diagnostics.filter((d) => d.severity === "error");
    if (probe.value !== undefined) problems.push(...traceErrors(truth, probeId, decisionPath(probeId), { decision: probe.value }));
    if (problems.length > 0) return failure(problems);
    const created = await createWithNewId(actor, "D", truth, render);
    if (created.value === undefined) return failure([...created.diagnostics]);
    // Committed. The rest is finished by the next operation if it fails here.
    const after: Diagnostic[] = [];
    try {
      if (target !== undefined) {
        after.push(...await updateInPlace(actor, target.location.path, "decision", new Set(["state", "superseded_by"]), { state: "superseded", superseded_by: created.value.id }));
      }
      const g = guard(actor, proposal.location.path, "proposal");
      if (g.value !== undefined) await fs.remove(g.value.absolute);
    } catch (error) {
      after.push(createDiagnostic("FILE_WRITE_ERROR", `${created.value.id} is confirmed; finishing failed and is repaired by the next operation: ${(error as Error).message}`));
    }
    return success({
      decisionId: created.value.id, path: created.value.path, from: id,
      ...(proposal.supersedes === null ? {} : { supersedes: proposal.supersedes }),
      ...(stale === undefined ? {} : { stale }),
      indexRequired: true as const, repaired,
    }, [...warnings, ...after.map((d) => ({ ...d, severity: "warning" as const }))]);
  }

  /** In-place confirm of a YAML Decision (ADR-013): proposed → confirmed, or confirmed without lock → lock added. */
  async function confirmDecision(actor: DecisionActor, id: string, truth: ProjectTruth, repaired: string[], warnings: Diagnostic[]): Promise<ParseResult<ConfirmResult>> {
    const d = truth.decisions.find((x) => x.id === id);
    if (d === undefined) return failure([createDiagnostic("PROPOSAL_NOT_FOUND", `No Decision ${id}`)]);
    if (!isServiceFile(d)) return failure([createDiagnostic("DECISION_TARGET_UNSUPPORTED", `${id} is not a decisions/D-###.yaml file; DUO does not rewrite it`, d.location)]);
    if (d.state === "superseded" || (d.state === CONFIRMED && d.lock !== undefined)) {
      return failure([createDiagnostic("DECISION_LOCKED", `${id} is ${d.state} and locked; supersede it with a new proposal`, d.location)]);
    }
    if (d.state === "rejected") return failure([createDiagnostic("PROPOSAL_NOT_PENDING", `${id} is rejected`, d.location)]);
    const digest = decisionLockDigest(d);
    const values: Record<string, unknown> = d.state === CONFIRMED
      ? { lock: { digest }, confirmed_at: d.confirmedAt ?? now(), confirmed_by: d.confirmedBy ?? actor.name }
      : { state: CONFIRMED, owner: "human", confirmed_at: now(), confirmed_by: actor.name, lock: { digest } };
    const target = d.supersedes === null ? undefined : truth.decisions.find((t) => t.id === d.supersedes);
    const problems = traceErrors(truth, id, d.location.path, { decision: d });
    if (d.supersedes !== null && target === undefined && problems.length === 0) {
      problems.push(createDiagnostic("BROKEN_REFERENCE", `${id} supersedes ${d.supersedes}, which does not exist`, d.location));
    }
    if (target !== undefined && problems.length === 0 && target.id !== id) {
      if (!isServiceFile(target)) problems.push(createDiagnostic("DECISION_TARGET_UNSUPPORTED", `${target.id} is not a decisions/D-###.yaml file`, target.location));
      else if (target.state !== CONFIRMED) problems.push(createDiagnostic("DECISION_SUPERSEDE_TARGET_INVALID", `${target.id} is ${target.state}`, target.location));
    }
    if (problems.length > 0) return failure(problems);
    const errors = await updateInPlace(actor, d.location.path, "decision", new Set(["state", "owner", "confirmed_at", "confirmed_by", "lock"]), values);
    if (errors.length > 0) return failure(errors);
    const after = target === undefined ? [] : await updateInPlace(actor, target.location.path, "decision", new Set(["state", "superseded_by"]), { state: "superseded", superseded_by: id });
    return success({
      decisionId: id, path: d.location.path as RepoPath, from: id, ...(d.supersedes === null ? {} : { supersedes: d.supersedes }), indexRequired: true as const, repaired,
    }, [...warnings, ...after.map((x) => ({ ...x, severity: "warning" as const }))]);
  }
}

