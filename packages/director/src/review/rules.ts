/**
 * Deterministic review rules (TASK-013, ADR-007). Only claims with clear grounds: explicit Project
 * Truth (locks, forbids, declared references, tests), Graph edges (IMPLEMENTS, GOVERNS,
 * VALIDATED_BY), Git hunks and caller-supplied test results. Where the meaning of code against a
 * Requirement or Constraint would have to be judged, the claim is UNKNOWN and a semantic candidate.
 */
import {
  canonicalSourceText, compareUtf8, compileRepoPattern, decisionLockDigest, fileRef, nodeId, parseDecisionFile, parseDefinitionMarkdown, readSourceFile,
  STATE_DIR_NAME, testRef, verifyDecisionLock, type Decision, type RepoPath,
} from "@duo-director/core";
import type { GitBlobSource, GitDiffEnd } from "@duo-director/analyzer";
import type { GraphNode } from "@duo-director/graph";
import { truthEvidence, truthEvidenceFromText, testRunEvidence } from "../evidence/sources.js";
import { matchConstraint, wildcard, type ScopeEntry } from "../relevance/policy.js";
import {
  decisionEvidence, isActive, makeClaim, nodeEvidence, requirementEvidence, seedEvidence, type RuleContext,
} from "./claims.js";
import { nonApplicationReason } from "./scope.js";
import { declaredReferenceParts, dependencyOffending, violationKey } from "../adoption/key.js";
import type { ChangedFile, DiffSeed, ReviewClaim } from "./types.js";

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
      const c = makeClaim(ctx, { rule: "decision-forbids", subject, key: `symbol:${s.id}`, alignment: "CONFLICT", reason: "forbidden-symbol", enforced,
        violation: { key: violationKey("decision-forbids", d.id, s.id), touched: true },
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
    const c = makeClaim(ctx, {
      rule: "test-coverage", subject: { kind: "requirement", id }, alignment: tests.length === 0 ? "PARTIAL" : "ALIGNED",
      reason: tests.length === 0 ? "no-related-test" : "related-test-exists",
      expected: `a Test validates ${id} or the changed code`,
      observed: tests.length === 0 ? "no VALIDATED_BY test" : `${tests.length} related test(s) in the graph (existence, not a run result)`,
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
