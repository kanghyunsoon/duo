/**
 * Deterministic review rules (TASK-013, ADR-007). Only claims with clear grounds: explicit Project
 * Truth (locks, forbids, declared references, tests), Graph edges (IMPLEMENTS, GOVERNS,
 * VALIDATED_BY), Git hunks and caller-supplied test results. Where the meaning of code against a
 * Requirement or Constraint would have to be judged, the claim is UNKNOWN and a semantic candidate.
 */
import {
  canonicalSourceText, compareUtf8, compileRepoPattern, decisionLockDigest, fileRef, nodeId, parseDecisionFile, parseDefinitionMarkdown, readSourceFile,
  STATE_DIR_NAME, testRef, verifyDecisionLock, type Decision, type RepoPath, type SourceLocation,
} from "@duo-director/core";
import { languageProfile, type GitBlobSource, type GitDiffEnd } from "@duo-director/analyzer";
import { readIndexedModuleReferences, type GraphNode, type IndexedModuleReference } from "@duo-director/graph";
import { moduleReferenceEvidence, truthEvidence, truthEvidenceFromText, testRunEvidence } from "../evidence/sources.js";
import { matchConstraint, wildcard, type ScopeEntry } from "../relevance/policy.js";
import {
  decisionEvidence, isActive, makeClaim, nodeEvidence, requirementEvidence, seedEvidence, type RuleContext,
} from "./claims.js";
import { nonApplicationReason } from "./scope.js";
import { declaredReferenceParts, dependencyOffending, violationKey } from "../adoption/key.js";
import { hunkRange } from "./seeds.js";
import type { ChangedFile, DiffSeed, ReviewClaim, ReviewLimitation } from "./types.js";

const DECISIONS = `${STATE_DIR_NAME}/decisions/`;
const PROPOSALS = `${STATE_DIR_NAME}/decisions/proposals/`;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const decoder = new TextDecoder("utf-8");

function blobSource(end: GitDiffEnd): GitBlobSource | undefined {
  if (end === "HEAD" || end === "INDEX") return end;
  return typeof end === "string" ? undefined : { commit: end.commit };
}

/** File text on one side of the diff; undefined when absent there. */
export async function sideText(ctx: RuleContext, side: GitDiffEnd, file: RepoPath): Promise<string | undefined> {
  if (side === "WORKTREE") return readSourceFile(ctx.root, file).value;
  const source = blobSource(side);
  if (source === undefined) return undefined;
  const blob = await ctx.git.readBlob(source, file);
  return blob.value === undefined ? undefined : canonicalSourceText(decoder.decode(blob.value));
}

function decisionsOf(file: RepoPath, text: string): Decision[] {
  if (file.endsWith(".md")) return [...(parseDefinitionMarkdown(file, text).value?.decisions ?? [])];
  const d = parseDecisionFile(file, text).value;
  return d === undefined ? [] : [d];
}

const decisionFiles = (ctx: RuleContext) => ctx.files.filter((f) => f.path.startsWith(DECISIONS) && !f.path.startsWith(PROPOSALS));
const codeSeeds = (ctx: RuleContext) => ctx.seeds.filter((s) => s.entity.type === "symbol" || s.entity.type === "file");

// ---- R-LOCK: decision-integrity, supersede-integrity ----

export async function decisionIntegrity(ctx: RuleContext): Promise<ReviewClaim[]> {
  const out: ReviewClaim[] = [];
  for (const f of decisionFiles(ctx)) {
    const oldPath = f.oldPath ?? f.path;
    const oldText = f.kind === "added" || f.kind === "untracked" ? undefined : await sideText(ctx, ctx.from, oldPath);
    const before = oldText === undefined ? [] : decisionsOf(oldPath, oldText);
    const after = f.kind === "deleted" ? [] : ctx.truth.decisions.filter((d) => d.location.path === f.path);
    const ids = [...new Set([...before.map((d) => d.id), ...after.map((d) => d.id)])].sort(compareUtf8);
    for (const id of ids) {
      const o = before.find((d) => d.id === id);
      const n = after.find((d) => d.id === id);
      const oldEvidence = o === undefined || oldText === undefined ? undefined
        : truthEvidenceFromText(ctx.store, { kind: "decision", id, title: o.title, location: o.location }, oldText, `old:${ctx.fromLabel}`);
      const newEvidence = n === undefined ? undefined : truthEvidence(ctx.store, ctx.reader, { kind: "decision", id, title: n.title, location: n.location });
      const evidence = [oldEvidence, newEvidence, ...f.evidenceIds];
      const subject = { kind: "decision", id };
      const wasConfirmed = o !== undefined && (o.state === "confirmed" || o.state === "superseded");
      if (n === undefined) {
        if (wasConfirmed) {
          const c = makeClaim(ctx, { rule: "decision-integrity", subject, alignment: "CONFLICT", reason: "confirmed-decision-removed", enforced: true, evidence,
            expected: `${id} stays in Project Truth (confirmed Decisions are superseded, not deleted)`, observed: `${id} was removed` });
          if (c !== undefined) out.push(c);
        }
        continue;
      }
      if (n.state !== "confirmed" && n.state !== "superseded") continue;
      const lock = verifyDecisionLock(n).value;
      let c: ReviewClaim | undefined;
      if (wasConfirmed && decisionLockDigest(o) !== decisionLockDigest(n)) {
        c = makeClaim(ctx, { rule: "decision-integrity", subject, alignment: "CONFLICT", reason: "confirmed-content-changed", enforced: true, evidence,
          expected: `confirmed ${id} content unchanged (supersede it with a new Decision instead)`, observed: `content fields of ${id} changed` });
      } else if (lock.status === "mismatch") {
        c = makeClaim(ctx, { rule: "decision-integrity", subject, alignment: "CONFLICT", reason: "lock-digest-mismatch", enforced: true, evidence,
          expected: `lock.digest of ${id} matches its content (${lock.expected})`, observed: `lock.digest is ${lock.recorded ?? "missing"}` });
      } else if (lock.status === "missing") {
        c = makeClaim(ctx, { rule: "decision-integrity", subject, alignment: "UNKNOWN", reason: "confirmed-without-lock", drift: true, evidence,
          expected: `${id} confirmed through the Decision lifecycle (with a lock)`, observed: `${id} is ${n.state} without lock.digest` });
      } else {
        c = makeClaim(ctx, { rule: "decision-integrity", subject, alignment: "ALIGNED", reason: wasConfirmed ? "lifecycle-change-only" : "confirmed-with-lock", evidence,
          expected: `${id} content protected by its lock`, observed: `lock valid; ${wasConfirmed ? "only lifecycle fields changed" : "newly confirmed with a lock"}` });
      }
      if (c !== undefined) out.push(c);
    }
  }
  return out;
}

export function supersedeIntegrity(ctx: RuleContext): ReviewClaim[] {
  const out: ReviewClaim[] = [];
  for (const f of decisionFiles(ctx)) {
    for (const d of ctx.truth.decisions.filter((x) => x.location.path === f.path && x.state === "confirmed" && x.supersedes !== null)) {
      const old = ctx.truth.decisions.find((x) => x.id === d.supersedes);
      const ok = old !== undefined && old.state === "superseded" && old.supersededBy === d.id;
      const c = makeClaim(ctx, {
        rule: "supersede-integrity", subject: { kind: "decision", id: d.id }, alignment: ok ? "ALIGNED" : "PARTIAL", reason: ok ? "supersede-consistent" : "supersede-inconsistent",
        expected: `${d.supersedes} is superseded_by ${d.id}`, observed: old === undefined ? `${d.supersedes} not found` : `${old.id} is ${old.state}, superseded_by ${old.supersededBy ?? "null"}`,
        evidence: [decisionEvidence(ctx, d.id), old === undefined ? undefined : decisionEvidence(ctx, old.id), ...f.evidenceIds],
      });
      if (c !== undefined) out.push(c);
    }
  }
  return out;
}

// ---- R-DECISION: decision-forbids, decision-governance ----

export function dependencyNames(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (typeof deps === "object" && deps !== null) for (const k of Object.keys(deps)) names.add(k);
    }
    return names;
  } catch {
    return new Set();
  }
}

export async function decisionForbids(ctx: RuleContext): Promise<ReviewClaim[]> {
  const out: ReviewClaim[] = [];
  const active = ctx.truth.decisions.filter((d) => isActive(d) && (d.forbids.paths.length + d.forbids.symbols.length + d.forbids.dependencies.length) > 0)
    .sort((a, b) => compareUtf8(a.id, b.id));
  if (active.length === 0) return out;
  const live = ctx.files.filter((f) => f.kind !== "deleted");
  const manifests = live.filter((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
  const added = new Map<string, Set<string>>();
  for (const m of manifests) {
    const before = dependencyNames(m.kind === "added" || m.kind === "untracked" ? undefined : await sideText(ctx, ctx.from, m.oldPath ?? m.path));
    const after = dependencyNames(await sideText(ctx, ctx.to, m.path));
    added.set(m.path, new Set([...after].filter((n) => !before.has(n))));
  }
  for (const d of active) {
    const enforced = d.enforcement === "block";
    const truth = decisionEvidence(ctx, d.id);
    const subject = { kind: "decision", id: d.id };
    const paths = d.forbids.paths.flatMap((p) => compileRepoPattern(p) ?? []);
    for (const f of live) {
      if (!paths.some((m) => m(f.path))) continue;
      const c = makeClaim(ctx, { rule: "decision-forbids", subject, key: `path:${f.path}`, alignment: "CONFLICT", reason: "forbidden-path", enforced,
        violation: { key: violationKey("decision-forbids", d.id, nodeId(fileRef(f.path))), touched: true },
        expected: `no change under ${d.forbids.paths.join(", ")} (${d.id})`, observed: `${f.kind} ${f.path}`,
        evidence: [truth, nodeEvidence(ctx, ctx.graph.getNode(fileRef(f.path))), ...f.evidenceIds] });
      if (c !== undefined) out.push(c);
    }
    const symbols = d.forbids.symbols.map(wildcard);
    for (const s of ctx.seeds.filter((x) => x.entity.type === "symbol")) {
      const qn = String(ctx.graph.getNode(s.entity)?.payload.qualifiedName ?? "");
      if (!symbols.some((re) => re.test(qn))) continue;
      const language = ctx.graph.getNode(fileRef(s.path))?.payload.language;
      const c = makeClaim(ctx, { rule: "decision-forbids", subject, key: `symbol:${s.id}`, alignment: "CONFLICT", reason: "forbidden-symbol", enforced,
        violation: { key: violationKey("decision-forbids", d.id, s.id), touched: true, ...(typeof language === "string" ? { language } : {}) },
        expected: `no symbol matching ${d.forbids.symbols.join(", ")} (${d.id})`, observed: `${qn} changed in ${s.path}`, evidence: [truth, ...seedEvidence(ctx, s)] });
      if (c !== undefined) out.push(c);
    }
    for (const [manifest, names] of added) {
      for (const dep of [...names].filter((n) => d.forbids.dependencies.includes(n)).sort(compareUtf8)) {
        const f = manifests.find((m) => m.path === manifest);
        const c = makeClaim(ctx, { rule: "decision-forbids", subject, key: `dependency:${manifest}:${dep}`, alignment: "CONFLICT", reason: "forbidden-dependency", enforced,
          violation: { key: violationKey("decision-forbids", d.id, dependencyOffending(manifest, dep)), touched: true },
          expected: `no dependency ${dep} (${d.id})`, observed: `${dep} added to ${manifest}`, evidence: [truth, ...(f?.evidenceIds ?? [])] });
        if (c !== undefined) out.push(c);
      }
    }
  }
  return out;
}

/** Requirements each code seed implements (IMPLEMENTS edges: declared or annotation). */
function implemented(ctx: RuleContext): Map<string, DiffSeed[]> {
  const out = new Map<string, DiffSeed[]>();
  for (const s of codeSeeds(ctx)) {
    const edges = ctx.graph.adjacentEdges([s.entity], { direction: "outgoing", types: ["IMPLEMENTS"], limit: 1000 }).edges;
    for (const e of edges) {
      const id = e.to.slice("req:".length);
      out.set(id, [...(out.get(id) ?? []), s]);
    }
  }
  return out;
}

export function decisionGovernance(ctx: RuleContext, conflicted: ReadonlySet<string>): ReviewClaim[] {
  const byDecision = new Map<string, DiffSeed[]>();
  const add = (id: string, s: DiffSeed) => { if (!(byDecision.get(id) ?? []).includes(s)) byDecision.set(id, [...(byDecision.get(id) ?? []), s]); };
  const active = new Map(ctx.truth.decisions.filter(isActive).map((d) => [d.id, d] as const));
  for (const s of codeSeeds(ctx)) {
    for (const e of ctx.graph.adjacentEdges([s.entity], { direction: "incoming", types: ["GOVERNS"], limit: 1000 }).edges) {
      const id = e.from.slice("dec:".length);
      if (active.has(id)) add(id, s);
    }
  }
  for (const [req, seeds] of implemented(ctx)) {
    for (const d of active.values()) if (d.governs.requirements.includes(req)) for (const s of seeds) add(d.id, s);
  }
  const out: ReviewClaim[] = [];
  for (const [id, seeds] of [...byDecision].sort(([a], [b]) => compareUtf8(a, b))) {
    if (conflicted.has(id)) continue;
    const c = makeClaim(ctx, {
      rule: "decision-governance", subject: { kind: "decision", id }, alignment: "ALIGNED", reason: "governed-no-forbidden-change",
      expected: `changes under ${id} respect its explicit forbids`, observed: `${seeds.map((s) => s.ref).join(", ")} governed by ${id}; no forbidden path, symbol or dependency`,
      evidence: [decisionEvidence(ctx, id), ...seeds.flatMap((s) => seedEvidence(ctx, s))],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

// ---- R-REQ, R-TEST ----

export function requirementImplementation(ctx: RuleContext): ReviewClaim[] {
  const current = ctx.truth.config.currentMilestone;
  const out: ReviewClaim[] = [];
  for (const [id, seeds] of [...implemented(ctx)].sort(([a], [b]) => compareUtf8(a, b))) {
    const r = ctx.truth.requirements.find((x) => x.id === id);
    if (r === undefined) continue;
    const outside = current !== null && r.milestone !== null && r.milestone !== current;
    const c = makeClaim(ctx, {
      rule: "requirement-implementation", subject: { kind: "requirement", id }, alignment: outside ? "PARTIAL" : "UNKNOWN",
      reason: outside ? "outside-current-milestone" : "meaning-not-decidable", semantic: !outside,
      expected: outside ? `changes serve the current milestone ${current}` : `the changed code does what ${id} asks`,
      observed: `${seeds.map((s) => s.ref).join(", ")} implement ${id}${outside ? ` (milestone ${r.milestone})` : " (declared or annotated link; meaning not checked)"}`,
      evidence: [requirementEvidence(ctx, id), ...seeds.flatMap((s) => seedEvidence(ctx, s))],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

function relatedTests(ctx: RuleContext, requirement: string, seeds: readonly DiffSeed[]): GraphNode[] {
  const ids = new Set<string>();
  const from = [{ type: "requirement" as const, id: requirement }, ...seeds.map((s) => s.entity)];
  for (const e of ctx.graph.adjacentEdges(from, { direction: "outgoing", types: ["VALIDATED_BY"], limit: 1000 }).edges) ids.add(e.to);
  return [...ids].sort(compareUtf8).flatMap((id) => ctx.graph.getNodes([testRefOf(id)].flatMap((r) => r ?? [])));
}

function testRefOf(id: string) {
  const body = id.slice("test:".length);
  const hash = body.indexOf("#");
  return hash < 0 ? undefined : testRef(body.slice(0, hash) as RepoPath, body.slice(hash + 1));
}

export function testCoverage(ctx: RuleContext): ReviewClaim[] {
  const out: ReviewClaim[] = [];
  for (const [id, seeds] of [...implemented(ctx)].sort(([a], [b]) => compareUtf8(a, b))) {
    const tests = relatedTests(ctx, id, seeds);
    // T18.0: when no changed implementation is in a language whose tests DUO can detect, "no related
    // test" is an analysis limit (plain UNKNOWN, never a warning), not a finding about the change.
    const detectable = seeds.some((s) => languageProfile(ctx.graph.getNode(fileRef(s.path))?.payload.language)?.capabilities.tests === "structural");
    const reason = tests.length > 0 ? "related-test-exists" : detectable ? "no-related-test" : "tests-not-analyzable";
    const c = makeClaim(ctx, {
      rule: "test-coverage", subject: { kind: "requirement", id }, alignment: tests.length > 0 ? "ALIGNED" : detectable ? "PARTIAL" : "UNKNOWN",
      reason,
      expected: `a Test validates ${id} or the changed code`,
      observed: tests.length > 0 ? `${tests.length} related test(s) in the graph (existence, not a run result)`
        : detectable ? "no VALIDATED_BY test" : "no VALIDATED_BY test; the changed files have no test analyzer, so tests in their language cannot be seen",
      evidence: [requirementEvidence(ctx, id), ...tests.slice(0, 5).map((t) => nodeEvidence(ctx, t)), ...seeds.flatMap((s) => s.evidenceIds)],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

export function testResults(ctx: RuleContext): ReviewClaim[] {
  const run = ctx.testResults;
  if (run === undefined) return [];
  const out: ReviewClaim[] = [];
  const reqOf = new Map<string, string[]>();
  const related = new Map<string, GraphNode>();
  for (const [id, seeds] of implemented(ctx)) {
    for (const t of relatedTests(ctx, id, seeds)) { related.set(t.id, t); reqOf.set(t.id, [...(reqOf.get(t.id) ?? []), id]); }
  }
  const blockGoverned = (req: string) => ctx.truth.decisions.some((d) => isActive(d) && d.enforcement === "block" && d.governs.requirements.includes(req));
  const passed: string[] = [];
  for (const t of run.tests ?? []) {
    const node = t.path !== undefined ? ctx.graph.getNode(testRef(t.path, t.name)) : [...related.values()].find((n) => n.payload.fullName === t.name);
    if (node === undefined || !related.has(node.id)) continue;
    const reqs = [...new Set(reqOf.get(node.id) ?? [])].sort(compareUtf8);
    const ev = testRunEvidence(ctx.store, run, t);
    if (t.status === "passed") { passed.push(ev, nodeEvidence(ctx, node) ?? ev); continue; }
    const c = makeClaim(ctx, {
      rule: "test-result", subject: { kind: "test", id: nodeId(node.ref) }, key: t.status, alignment: t.status === "failed" ? "CONFLICT" : "UNKNOWN",
      reason: t.status === "failed" ? "related-test-failed" : "related-test-skipped", enforced: t.status === "failed" && reqs.some(blockGoverned),
      expected: `tests validating ${reqs.join(", ")} pass`, observed: `${t.name}: ${t.status}`,
      evidence: [ev, nodeEvidence(ctx, node), ...reqs.map((r) => requirementEvidence(ctx, r))],
    });
    if (c !== undefined) out.push(c);
  }
  if (passed.length > 0) {
    const c = makeClaim(ctx, { rule: "test-result", subject: { kind: "test-run", id: run.command ?? "run" }, key: "passed", alignment: "ALIGNED", reason: "related-tests-passed",
      expected: "related tests pass", observed: `${passed.length / 2} related test(s) passed`, evidence: passed });
    if (c !== undefined) out.push(c);
  }
  if (run.status === "failed" && (run.tests ?? []).length === 0) {
    const c = makeClaim(ctx, { rule: "test-result", subject: { kind: "test-run", id: run.command ?? "run" }, key: "failed", alignment: "CONFLICT", reason: "test-run-failed",
      expected: "the test run passes", observed: "the run failed; no per-test results were given", evidence: [testRunEvidence(ctx.store, run, undefined)] });
    if (c !== undefined) out.push(c);
  }
  return out;
}

// ---- R-CONSTRAINT (shared relevance policy), declared references, R-SCOPE ----

export function constraintCompliance(ctx: RuleContext): ReviewClaim[] {
  const entries: ScopeEntry[] = codeSeeds(ctx).map((s) => {
    const node = ctx.graph.getNode(s.entity);
    const qn = node?.payload.qualifiedName;
    return { id: s.id, ref: s.ref, type: s.entity.type, hops: 0, seed: "explicit", path: s.path, ...(typeof qn === "string" ? { qualifiedName: qn } : {}) };
  });
  const out: ReviewClaim[] = [];
  for (const k of ctx.truth.constraints.filter((c) => c.state === "confirmed")) {
    const r = matchConstraint(k, { entries, taskText: ctx.task });
    if (r.relevance === "none") continue;
    const seed = ctx.seeds.find((s) => s.id === r.matched);
    const c = makeClaim(ctx, {
      rule: "constraint-compliance", subject: { kind: "constraint", id: k.id }, alignment: "UNKNOWN", reason: "meaning-not-decidable", semantic: true,
      expected: `${k.statement}`, observed: `${r.reasons.map((x) => `${x.code} ${x.ref ?? ""}`.trim()).join("; ")} (compliance needs a semantic check)`,
      evidence: [decisionEvidence(ctx, k.id), ...(seed === undefined ? [] : seedEvidence(ctx, seed))],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

export function declaredReferences(ctx: RuleContext): ReviewClaim[] {
  const inPacket = new Set((ctx.reviewPacket === undefined ? [] : [...ctx.reviewPacket.intent.requirements, ...ctx.reviewPacket.decisions.active]).map((i) => i.ref));
  const changed = new Set<string>(ctx.files.map((f) => f.path));
  const defs = [
    ...ctx.truth.requirements.map((d) => ({ kind: "requirement" as const, id: d.id, location: d.location })),
    ...ctx.truth.decisions.map((d) => ({ kind: "decision" as const, id: d.id, location: d.location })),
  ];
  const out: ReviewClaim[] = [];
  for (const diag of ctx.stateDiagnostics.filter((x) => x.code === "DECLARED_SYMBOL_UNRESOLVED" && x.source !== undefined)) {
    const line = diag.source?.startLine ?? 0;
    const def = defs.find((d) => d.location.path === diag.source?.path && (d.location.startLine ?? 0) <= line && line <= (d.location.endLine ?? 0));
    if (def === undefined || !(inPacket.has(def.id) || changed.has(def.location.path))) continue;
    const parts = declaredReferenceParts(diag.message);
    const c = makeClaim(ctx, {
      rule: "declared-reference", subject: { kind: def.kind, id: def.id }, key: diag.message, alignment: "PARTIAL", reason: "declared-symbol-unresolved",
      ...(parts === undefined ? {} : { violation: { key: violationKey("declared-reference", parts.governing, parts.offending), touched: changed.has(def.location.path) } }),
      expected: `every symbol ${def.id} names exists`, observed: diag.message,
      evidence: [def.kind === "requirement" ? requirementEvidence(ctx, def.id) : decisionEvidence(ctx, def.id)],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

/** covered: added files that unlinked-addition already reports (one drift claim per file). */
export function scopeRelevance(ctx: RuleContext, covered: ReadonlySet<string> = new Set()): ReviewClaim[] {
  const scope = ctx.taskScope;
  if (scope === undefined) return [];
  const out: ReviewClaim[] = [];
  for (const f of ctx.files) {
    // The same application-source policy as unlinked-addition: tests, configuration, tooling, generated and docs are not scope findings.
    if (f.kind === "deleted" || covered.has(f.path) || f.path.startsWith(`${STATE_DIR_NAME}/`) || TEST_FILE.test(f.path) || nonApplicationReason(f.path) !== undefined) continue;
    const node = ctx.graph.getNode(fileRef(f.path));
    if (node === undefined || typeof node.payload.language !== "string") continue; // config, docs, data: not application code
    const seeds = ctx.seeds.filter((s) => s.path === f.path);
    const inScope = scope.has(node.id) || seeds.some((s) => scope.has(s.id));
    const c = makeClaim(ctx, {
      rule: "scope-relevance", subject: { kind: "file", id: f.path }, alignment: inScope ? "ALIGNED" : "UNKNOWN", reason: inScope ? "in-task-context" : "outside-task-context",
      drift: !inScope, expected: "changed application code belongs to the task's context",
      observed: inScope ? `${f.path} is in the task's context` : `${f.path} is not connected to the task's context (a drift signal, not a conflict)`,
      evidence: [nodeEvidence(ctx, node), ...f.evidenceIds],
    });
    if (c !== undefined) out.push(c);
  }
  return out;
}

export function implementedRequirements(ctx: RuleContext): ReadonlyMap<string, readonly ChangedFile["path"][]> {
  return new Map([...implemented(ctx)].map(([k, v]) => [k, v.map((s) => s.path)]));
}
// ---- R-IMPORT: decision-forbids-import (H-72) ----

const overlapsLines = (loc: SourceLocation, [a, b]: readonly [number, number]) => {
  const start = loc.startLine ?? 1;
  return start <= b && (loc.endLine ?? start) >= a;
};
const preview = (items: readonly string[]) => `${items.slice(0, 5).join(", ")}${items.length > 5 ? `, … (${items.length} in all)` : ""}`;

/** H-72: the Decision was confirmed after the Adoption Baseline was recorded (UTC ISO 8601 on both sides). */
function confirmedAfterBaseline(confirmedAt: string | undefined, recordedAt: string | undefined): boolean {
  if (confirmedAt === undefined || recordedAt === undefined) return false;
  const c = Date.parse(confirmedAt);
  const r = Date.parse(recordedAt);
  return Number.isFinite(c) && Number.isFinite(r) && c > r;
}

/**
 * H-72: a module reference (import, export-from, dynamic import, require, Python import, C++ quoted
 * include; type-only included) on a changed new-side line whose indexed resolution is exactly one
 * repository file that an active Decision's forbids.imported_paths matches: CONFLICT forbidden-import.
 * The claim says "on a changed line"; it does not prove the relation is new. Unresolved, ambiguous and
 * unsupported references never conflict and no text similarity is guessed: they are limitations. An
 * external package is forbids.dependencies. A pattern that matches no file is not reported.
 */
export async function decisionForbidsImport(ctx: RuleContext): Promise<{ readonly claims: ReviewClaim[]; readonly limitations: ReviewLimitation[] }> {
  const decisions = ctx.truth.decisions.filter((d) => isActive(d) && (d.forbids.importedPaths?.length ?? 0) > 0).sort((a, b) => compareUtf8(a.id, b.id));
  if (decisions.length === 0) return { claims: [], limitations: [] };
  const matchers = decisions.map((d) => ({ d, match: (d.forbids.importedPaths ?? []).flatMap((p) => compileRepoPattern(p) ?? []) }));
  const changed = ctx.files.filter((f) => f.kind !== "deleted" && !f.binary && !f.path.startsWith(`${STATE_DIR_NAME}/`) && f.hunks.length > 0);
  // The index describes the working tree; another reviewed side is evaluated only where its text is the same.
  const usable: ChangedFile[] = [];
  const otherSide: string[] = [];
  for (const f of changed) {
    if (ctx.to === "WORKTREE") { usable.push(f); continue; }
    const side = await sideText(ctx, ctx.to, f.path);
    const current = readSourceFile(ctx.root, f.path).value;
    if (side !== undefined && current !== undefined && side === canonicalSourceText(current)) usable.push(f);
    else otherSide.push(f.path);
  }
  const indexed = await readIndexedModuleReferences(ctx.root, usable.map((f) => f.path));
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  const unsupported: string[] = [];
  const notIndexedTarget: string[] = [];
  const unavailable: string[] = [];
  const groups = new Map<string, { d: Decision; source: RepoPath; target: RepoPath; sites: { ref: IndexedModuleReference; hunks: string[] }[] }>();
  usable.forEach((f, i) => {
    const r = indexed[i];
    if (r === undefined || r.status === "unavailable") { unavailable.push(f.path); return; }
    if (r.status !== "ok") return; // no analyzer (L0): the changed file's capability limitation is reported already
    for (const ref of r.references) {
      const hunks = f.hunks.filter((h) => overlapsLines(ref.location, hunkRange(h))).map((h) => h.evidenceId);
      if (hunks.length === 0) continue;
      const where = `${f.path}:${ref.location.startLine ?? "?"}`;
      const target = ref.target;
      if (target === undefined) {
        const s = ref.resolution.status;
        if (s === "unresolved") unresolved.push(where);
        else if (s === "ambiguous") ambiguous.push(where);
        else if (s === "unsupported") unsupported.push(where);
        else if (s === "resolved") notIndexedTarget.push(where);
        continue; // external: forbids.dependencies, not imported_paths
      }
      for (const { d, match } of matchers) {
        if (!match.some((m) => m(target))) continue;
        const key = `${d.id}\n${f.path}\n${target}`;
        const g = groups.get(key) ?? { d, source: f.path, target, sites: [] };
        g.sites.push({ ref, hunks });
        groups.set(key, g);
      }
    }
  });
  const coverage = ctx.baselineEvaluatedRules?.has("decision-forbids-import") === true;
  const claims: ReviewClaim[] = [];
  for (const g of [...groups.values()].sort((a, b) => compareUtf8(a.d.id, b.d.id) || compareUtf8(a.source, b.source) || compareUtf8(a.target, b.target))) {
    const where = g.sites.map((s) => `${g.source}:${s.ref.location.startLine ?? "?"} ${s.ref.kind} "${s.ref.specifier}"${s.ref.typeOnly ? " (type-only)" : ""}`).join("; ");
    // A baseline that did not evaluate this rule cannot say whether the relation existed at adoption (H-72),
    // unless the Decision itself was confirmed after the baseline was recorded.
    const unverifiable = ctx.baselineKeys !== undefined && !coverage && !confirmedAfterBaseline(g.d.confirmedAt, ctx.baselineRecordedAt);
    const c = makeClaim(ctx, {
      rule: "decision-forbids-import", subject: { kind: "decision", id: g.d.id }, key: `import:${g.source}->${g.target}`, alignment: "CONFLICT", reason: "forbidden-import",
      enforced: g.d.enforcement === "block",
      expected: `no changed import resolves to ${(g.d.forbids.importedPaths ?? []).join(", ")} (${g.d.id})`,
      observed: `forbidden import on a changed line: ${where} resolves to ${g.target}`,
      evidence: [
        decisionEvidence(ctx, g.d.id),
        ...g.sites.map((s) => moduleReferenceEvidence(ctx.store, ctx.reader, { path: g.source, location: s.ref.location, kind: s.ref.kind, specifier: s.ref.specifier, typeOnly: s.ref.typeOnly, target: g.target }, ctx.toLabel)),
        ...g.sites.flatMap((s) => s.hunks),
        nodeEvidence(ctx, ctx.graph.getNode(fileRef(g.target))),
      ],
      violation: { key: violationKey("decision-forbids-import", g.d.id, `import:${nodeId(fileRef(g.source))}->${nodeId(fileRef(g.target))}`), touched: true, ...(unverifiable ? { unverifiable: true } : {}) },
    });
    if (c !== undefined) claims.push(c);
  }
  const limitations: ReviewLimitation[] = [];
  const not = "were not checked against forbids.imported_paths";
  if (unresolved.length > 0) limitations.push({ code: "imports-unresolved", message: `${unresolved.length} changed import(s) did not resolve to a repository file and ${not}: ${preview(unresolved)}.` });
  if (ambiguous.length > 0) limitations.push({ code: "imports-ambiguous", message: `${ambiguous.length} changed import(s) have more than one candidate file and ${not}: ${preview(ambiguous)}.` });
  if (unsupported.length > 0) limitations.push({ code: "imports-resolution-unsupported", message: `${unsupported.length} changed import(s) are in a language without module resolution (imports are recorded as written) and ${not}: ${preview(unsupported)}.` });
  if (notIndexedTarget.length > 0) limitations.push({ code: "imports-target-not-indexed", message: `${notIndexedTarget.length} changed import(s) resolve to a file outside the index and ${not}: ${preview(notIndexedTarget)}.` });
  if (unavailable.length > 0) limitations.push({ code: "imports-index-unavailable", message: `The indexed imports of ${unavailable.length} changed file(s) could not be read and ${not}: ${preview(unavailable)}.` });
  if (otherSide.length > 0) limitations.push({ code: "imports-reviewed-side-not-indexed", message: `${otherSide.length} changed file(s) differ on the reviewed side from the indexed working tree; their imports ${not}: ${preview(otherSide)}.` });
  return { claims, limitations };
}

