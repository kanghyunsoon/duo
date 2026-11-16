/**
 * Decision read API (BE-API-02, T95): the Decision list and one Decision with its lock status and
 * supersession chain, for the local UI. Read-only: it loads Project Truth, computes what the files say and
 * writes nothing. Every field comes from the Decision files as they are now; nothing is inferred from Git
 * history, and no field claims more than the files show:
 *
 * - "lockStatus" is verifyDecisionLock(): the recorded digest against the content (valid, missing,
 *   mismatch, not-confirmed). A valid lock is evidence of the confirm workflow, not an authentication
 *   (ADR-013, docs/10-security.md): a recomputed digest cannot be told apart.
 * - "origin" is "lifecycle" when a confirmed or superseded Decision carries a lock, "manual" when it has none
 *   (the ADR-013 manual fallback), null when it is not confirmed.
 * - "confirmedBy" and "proposedBy" are the labels written in the file. They are not identities.
 * - "integrity" lists the loader's error diagnostics for that Decision (lock mismatch, lifecycle problems,
 *   broken references, H-82). A diagnostic belongs to a Decision when its message names the Decision first
 *   ("D-001: ...") or when its source location falls inside that Decision's own source range: the narrowest
 *   definition in the same file that contains the diagnostic's line. A diagnostic whose location cannot
 *   decide between definitions stays only in "truth". "truth.complete" is false when any blocking Truth error
 *   exists, in which case review, context and the Decision lifecycle refuse to decide (requireCompleteTruth, H-75).
 * - "chain" stops after MAX_CHAIN links in each direction; "truncated" says whether a further link was declared
 *   past that limit, so a client never mistakes a partial chain for the whole history.
 *
 * No role or Team Mode check is made here (ADR-015 is not approved).
 */
import {
  compareUtf8, truthAuthorityErrors, verifyDecisionLock, type Decision, type Diagnostic, type LockVerification, type ProjectTruth, type SourceLocation,
} from "@duo-director/core";
import { guarded, project, type Failure, type Operation } from "../operations/common.js";
import { decisionLabel } from "./projection.js";

export type DecisionStateFilter = Decision["state"];
export interface DecisionListQuery { readonly state?: DecisionStateFilter; readonly q?: string }

export interface TruthProblem { readonly code: string; readonly message: string; readonly path?: string; readonly line?: number }
export interface TruthHealth { readonly complete: boolean; readonly problems: readonly TruthProblem[] }

const MAX_CHAIN = 64;

const loc = (l: SourceLocation) => ({ path: l.path, ...(l.startLine === undefined ? {} : { startLine: l.startLine }), ...(l.endLine === undefined ? {} : { endLine: l.endLine }) });

/** A diagnostic as the UI may show it: no absolute path of this machine. */
function problemOf(root: string, d: Diagnostic): TruthProblem {
  const forms = [...new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")])].filter((f) => f.length > 1);
  let message = d.message;
  for (const f of forms) message = message.split(f).join("<repository>");
  return { code: d.code, message, ...(d.source?.path === undefined ? {} : { path: d.source.path }), ...(d.source?.startLine === undefined ? {} : { line: d.source.startLine }) };
}

function truthHealth(root: string, diagnostics: readonly Diagnostic[]): TruthHealth {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return { complete: truthAuthorityErrors(diagnostics).length === 0, problems: errors.map((d) => problemOf(root, d)) };
}

/** Anything the loader read with a source range: Requirements, Decisions, Constraints, Issues, Milestones. */
type Located = { readonly id: string; readonly location: SourceLocation };
/** Diagnostic → the definition whose source range it falls in, or undefined when the location cannot decide. */
type Owners = ReadonlyMap<Diagnostic, Located | undefined>;

/**
 * Attributes each error diagnostic to the definition it was reported in. A file can hold several definitions
 * (an ADR-style Decision spans the whole file and may contain Requirement sections), so the owner is the
 * narrowest definition in the diagnostic's file whose line range contains the diagnostic's start line. Without
 * a line, or when two equally narrow ranges contain it, the owner is undecided unless the file holds exactly one
 * definition. Nothing is guessed from IDs inside the message text.
 */
function ownersOf(truth: ProjectTruth, diagnostics: readonly Diagnostic[]): Owners {
  const byPath = new Map<string, Located[]>();
  for (const def of [...truth.requirements, ...truth.decisions, ...truth.constraints, ...truth.issues, ...truth.milestones]) {
    const list = byPath.get(def.location.path);
    if (list === undefined) byPath.set(def.location.path, [def]); else list.push(def);
  }
  const owners = new Map<Diagnostic, Located | undefined>();
  for (const x of diagnostics) {
    if (x.severity !== "error" || x.source === undefined) continue;
    const defs = byPath.get(x.source.path) ?? [];
    const line = x.source.startLine;
    if (defs.length === 1) { owners.set(x, defs[0]); continue; }
    if (line === undefined) { owners.set(x, undefined); continue; }
    let best: Located | undefined;
    let bestSize = Number.POSITIVE_INFINITY;
    let tie = false;
    for (const def of defs) {
      const start = def.location.startLine;
      if (start === undefined) continue;
      const end = def.location.endLine ?? start;
      if (line < start || line > end) continue;
      const size = end - start;
      if (size < bestSize) { best = def; bestSize = size; tie = false; } else if (size === bestSize) tie = true;
    }
    owners.set(x, tie ? undefined : best);
  }
  return owners;
}

/** Error diagnostics about one Decision: reported inside its own source range, or a message that names it first ("D-001: ..."). */
function problemsOf(root: string, d: Decision, diagnostics: readonly Diagnostic[], owners: Owners): TruthProblem[] {
  return diagnostics
    .filter((x) => x.severity === "error" && (x.message.startsWith(d.id + ":") || owners.get(x) === d))
    .map((x) => problemOf(root, x));
}

function summaryOf(root: string, d: Decision, diagnostics: readonly Diagnostic[], owners: Owners) {
  const lock = verifyDecisionLock(d).value;
  const lifecycle = d.state === "confirmed" || d.state === "superseded";
  const problems = problemsOf(root, d, diagnostics, owners);
  return {
    id: d.id, title: d.title, kind: d.decisionKind, state: d.state, authority: decisionLabel(d), enforcement: d.enforcement ?? null,
    locked: d.lock !== undefined, lockStatus: lock.status, origin: lifecycle ? (d.lock === undefined ? "manual" : "lifecycle") : null,
    supersedes: d.supersedes, supersededBy: d.supersededBy,
    ...(d.proposalId === undefined ? {} : { proposalId: d.proposalId }),
    ...(d.confirmedAt === undefined ? {} : { confirmedAt: d.confirmedAt }), ...(d.confirmedBy === undefined ? {} : { confirmedBy: d.confirmedBy }),
    integrity: problems.length === 0 ? "ok" as const : "invalid" as const, problems,
    location: loc(d.location),
  };
}

type Link = { readonly id: string; readonly state?: string; readonly authority?: string; readonly missing?: true; readonly loop?: true };
const node = (x: Decision): Link => ({ id: x.id, state: x.state, authority: decisionLabel(x) });

/**
 * One direction of the chain, at most MAX_CHAIN links (a missing or loop marker counts as a link). truncated is
 * true only when the walk stopped at the limit while the last returned Decision still declares a further link;
 * a chain that ends exactly at the limit is not truncated. A client can continue from the last returned ID.
 */
function walk(first: string | null, next: (x: Decision) => string | null, seen: Set<string>, byId: ReadonlyMap<string, Decision>) {
  const links: Link[] = [];
  for (let at = first; at !== null;) {
    if (links.length === MAX_CHAIN) return { links, truncated: true };
    if (seen.has(at)) { links.push({ id: at, loop: true }); break; }
    seen.add(at);
    const x = byId.get(at);
    if (x === undefined) { links.push({ id: at, missing: true }); break; }
    links.push(node(x));
    at = next(x);
  }
  return { links, truncated: false };
}

/** The supersession chain through id, oldest first. A missing Decision or a loop ends the walk and is marked. */
function chainOf(d: Decision, byId: ReadonlyMap<string, Decision>) {
  const seen = new Set([d.id]);
  const back = walk(d.supersedes, (x) => x.supersedes, seen, byId);
  const forward = walk(d.supersededBy, (x) => x.supersededBy, seen, byId);
  return { chain: [...back.links.reverse(), node(d), ...forward.links], truncated: { older: back.truncated, newer: forward.truncated } };
}

/** GET /api/decisions: every Decision the loader read (ID order), optionally by state or a text match. */
export function projectDecisionList(root: string, query: DecisionListQuery = {}): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const diagnostics = p.diagnostics ?? [];
    const owners = ownersOf(p.value.truth, diagnostics);
    const needle = query.q?.toLowerCase();
    const decisions = [...p.value.truth.decisions]
      .sort((a, b) => compareUtf8(a.id, b.id))
      .filter((d) => query.state === undefined || d.state === query.state)
      .filter((d) => needle === undefined || d.id.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle))
      .map((d) => summaryOf(root, d, diagnostics, owners));
    return { kind: "ok", diagnostics: [], payload: { decisions, actorLabelsAuthenticated: false, truth: truthHealth(root, diagnostics) } };
  });
}

/** GET /api/decisions/{id}: one Decision with its content, lock verification and supersession chain, or not-found. */
export function projectDecisionDetail(root: string, id: string): Promise<Operation<Record<string, unknown>>> {
  return guarded<Record<string, unknown>>(async () => {
    const p = project(root);
    if (p.value === undefined) return p.outcome as Failure;
    const diagnostics = p.diagnostics ?? [];
    const truth = truthHealth(root, diagnostics);
    const byId = new Map<string, Decision>();
    for (const d of p.value.truth.decisions) if (!byId.has(d.id)) byId.set(d.id, d);
    const d = byId.get(id);
    if (d === undefined) return { kind: "ok", diagnostics: [], payload: { status: "not-found", id, truth } };
    const lock: LockVerification = verifyDecisionLock(d).value;
    const { chain, truncated } = chainOf(d, byId);
    return {
      kind: "ok", diagnostics: [],
      payload: {
        status: "found", id,
        decision: {
          ...summaryOf(root, d, diagnostics, ownersOf(p.value.truth, diagnostics)),
          question: d.question, answer: d.answer, rationale: d.rationale ?? null, governs: d.governs, forbids: d.forbids,
          ...(d.proposedAt === undefined ? {} : { proposedAt: d.proposedAt }), ...(d.proposedBy === undefined ? {} : { proposedBy: d.proposedBy }),
          ...(d.proposedByKind === undefined ? {} : { proposedByKind: d.proposedByKind }),
          lock, chain, truncated,
        },
        actorLabelsAuthenticated: false, truth,
      },
    };
  });
}
