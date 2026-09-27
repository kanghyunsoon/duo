/**
 * Project Graph Builder (TASK-007): facts → GraphBuildPlan. Only relations explained by evidence
 * are planned: declared Project Truth references, explicit "duo:" annotations, module references
 * that TypeScript resolves to one indexed file, calls resolved exactly from syntax facts, and Git
 * co-change counts above the 04 threshold. A missing edge is preferred to a wrong one. No source is
 * parsed again and no LLM is used. Nothing here is global: every index belongs to one build.
 *
 * The same builder serves full and incremental builds (TASK-008). An incremental build passes a
 * ResolutionMemo so unchanged module and call results are reused; everything else is recomputed
 * from the facts, so the plan equals the plan of a clean full build of the same state.
 */
import {
  extractIssueKeys,
  type AnalyzedSymbol, type AnalyzedTest, type CallSite, type ImportBinding, type ModuleReference, type SourceAnalysis,
} from "@duo-director/analyzer";
import {
  compareSourceLocations, compareUtf8, compileRepoPattern, createDiagnostic, definitionRef, ENTITY_TYPES, fileRef, nodeId,
  PROJECT_REF, STATE_DIR_NAME, testRef,
  type Diagnostic, type EntityRef, type EntityType, type RepoPath, type SourceLocation, type SymbolRef,
} from "@duo-director/core";
import { GRAPH_EDGE_TYPES, type GraphEdgeInput, type GraphEdgeType, type GraphNodeInput, type JsonObject } from "../store/types.js";
import { canonicalJson } from "../store/json.js";
import { attachAnnotation, type AttachmentCandidate } from "./annotations.js";
import { isEdgeEndpointAllowed } from "./endpoints.js";
import { ExportIndex, type ExportLookup } from "./exports.js";
import { payloadProblem } from "./payload.js";
import type { ModuleResolution, ModuleResolutionStatus } from "./resolve/module-resolver.js";
import type {
  CallResolution, CallResolutionFreshness, CallResolutionStatus, EdgeCategory, FileResolution, GraphBuildInput, GraphBuildPlan, GraphBuildStats,
  ModuleResolutionRecord, ResolutionMemo, StoredCallOutcome,
} from "./types.js";

/** Files whose symbols are test helpers, never validated code (VALIDATED_BY from calls). */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const STATE_PREFIX = `${STATE_DIR_NAME}/`;

/** Version of the call resolution rules. Stored call results with another version are recomputed (TASK-008). */
export const CALL_RESOLUTION_VERSION = 1;

type Json = JsonObject;
const json = (value: object): Json => JSON.parse(JSON.stringify(value)) as Json;
const clean = (value: Record<string, unknown>): Json => json(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)));

/** Evidence strength for merging one relation found by several facts (04 provenance). */
const PROVENANCE_RANK: Readonly<Record<string, number>> = { declared: 3, static: 2, git: 1, heuristic: 0 };

/** Default merge: strongest provenance, union of bases, first value for other keys. */
function mergeEvidence(old: Json, next: Json): Json {
  const rank = (m: Json) => PROVENANCE_RANK[String(m.provenance)] ?? -1;
  const bases = [...new Set([old.basis, next.basis].flatMap((b) => (Array.isArray(b) ? b.map(String) : [])))].sort(compareUtf8);
  return json({ ...next, ...old, provenance: rank(next) > rank(old) ? next.provenance : old.provenance, ...(bases.length > 0 ? { basis: bases } : {}) });
}

/** Wildcard match for Requirement.tests (test fullName patterns): "*" any text, "?" one character. */
function wildcard(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) source += ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
  return new RegExp(`^${source}$`, "u");
}

const CALLABLE_BY_KIND: Readonly<Record<CallSite["kind"], ReadonlySet<string>>> = {
  identifier: new Set(["function"]),
  member: new Set(["function", "method"]),
  constructor: new Set(["class"]),
};

interface FileContext {
  readonly analysis: SourceAnalysis;
  readonly analyzerVersion: string;
  readonly bindings: ReadonlyMap<string, { readonly ref: ModuleReference; readonly binding: ImportBinding }>;
  readonly byIdentity: ReadonlyMap<string, AnalyzedSymbol>;
  readonly topLevel: ReadonlyMap<string, readonly AnalyzedSymbol[]>;
  /** Test Nodes of the file (duplicates removed). */
  readonly tests: readonly AnalyzedTest[];
}

type Target = { readonly file: RepoPath; readonly symbol: AnalyzedSymbol };
type CallOutcome = { readonly status: CallResolutionStatus; readonly reason?: string; readonly target?: Target };

const OWNED_TYPES = new Set<EntityType>(["symbol", "test"]);
const union = (a: unknown, b: readonly string[]) => [...new Set([...(Array.isArray(a) ? a.map(String) : []), ...b])].sort(compareUtf8);

class Builder {
  private readonly nodes = new Map<string, GraphNodeInput>();
  private readonly edges = new Map<string, GraphEdgeInput>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly moduleResolutions: ModuleResolutionRecord[] = [];
  private readonly callResolutions: CallResolution[] = [];
  private readonly contexts = new Map<RepoPath, FileContext>();
  private readonly filePaths = new Set<RepoPath>();
  private valid = true;
  private readonly calls: Record<CallResolutionStatus, number> & { exactWithoutSourceSymbol: number } =
    { exact: 0, heuristic: 0, ambiguous: 0, unresolved: 0, exactWithoutSourceSymbol: 0 };
  private readonly annotations = { symbol: 0, test: 0, file: 0, unknownId: 0, unsupportedId: 0 };
  private readonly exportIndex: ExportIndex;
  private readonly moduleResults = new Map<RepoPath, ReadonlyMap<ModuleReference, ModuleResolution>>();
  private readonly resolution = new Map<RepoPath, FileResolution>();
  private readonly callFreshness = new Map<RepoPath, CallResolutionFreshness>();
  private readonly configDiagnosticsOut = new Map<RepoPath, readonly Diagnostic[]>();
  private readonly work = { filesModulesRecomputed: 0, modulesRecomputed: 0, modulesReused: 0, filesCallsRecomputed: 0, callsRecomputed: 0, callsReused: 0 };

  constructor(private readonly input: GraphBuildInput, private readonly memo?: ResolutionMemo) {
    const analyses = new Map(input.analyses.map((a) => [a.analysis.path, a.analysis] as const));
    this.exportIndex = new ExportIndex(analyses, (from, ref) => this.moduleResult(from, ref));
  }

  // ---- nodes and edges ----

  private addNode(ref: EntityRef, payload: Json, source: SourceLocation | undefined, contentHash?: string): void {
    // Symbol and Test nodes belong to the file they were extracted from (incremental deletion key).
    const ownerFile = OWNED_TYPES.has(ref.type) && "path" in ref ? ref.path : undefined;
    const node: GraphNodeInput = {
      ref, payload, ...(source === undefined ? {} : { source }), ...(contentHash === undefined ? {} : { contentHash }),
      ...(ownerFile === undefined ? {} : { ownerFile }),
    };
    const id = nodeId(ref);
    const existing = this.nodes.get(id);
    if (existing !== undefined) {
      if (canonicalJson(json(existing), "node") !== canonicalJson(json(node), "node")) {
        this.valid = false;
        this.diagnostics.push(createDiagnostic("GRAPH_NODE_CONFLICT", `Two facts produce node ${id} with different content`, source));
      }
      return;
    }
    const problem = payloadProblem(ref.type, payload);
    if (problem !== undefined) {
      this.valid = false;
      this.diagnostics.push(createDiagnostic("GRAPH_PAYLOAD_INVALID", `${id}: ${problem}`, source));
      return;
    }
    this.nodes.set(id, node);
  }

  /** Adds an edge; an existing (from, type, to) keeps one row and merges metadata and categories. */
  private addEdge(from: EntityRef, type: GraphEdgeType, to: EntityRef, category: EdgeCategory, metadata: Json, merge?: (old: Json) => Json): void {
    const key = `${nodeId(from)}\u0000${type}\u0000${nodeId(to)}`;
    const existing = this.edges.get(key);
    const old = existing?.metadata;
    const merged = old === undefined ? metadata : merge === undefined ? mergeEvidence(old, metadata) : merge(old);
    this.edges.set(key, { from, type, to, metadata: json({ ...merged, categories: union(old?.categories, [category]) }) });
  }

  private has(ref: EntityRef): boolean {
    return this.nodes.has(nodeId(ref));
  }

  // ---- facts ----

  build(): GraphBuildPlan {
    this.definitions();
    this.filesAndCode();
    this.declaredCodeRelations();
    this.modulesAndCalls();
    this.annotationRelations();
    this.coChange();
    this.validate();
    const nodes = [...this.nodes.values()].sort((a, b) => compareUtf8(nodeId(a.ref), nodeId(b.ref)));
    const edges = [...this.edges.values()].sort((a, b) =>
      compareUtf8(nodeId(a.from), nodeId(b.from)) || compareUtf8(a.type, b.type) || compareUtf8(nodeId(a.to), nodeId(b.to)));
    return {
      nodes, edges, diagnostics: this.diagnostics, stats: this.stats(nodes, edges),
      moduleResolutions: this.moduleResolutions, callResolutions: this.callResolutions,
      resolution: this.resolution, resolutionWork: { ...this.work, callFreshness: this.callFreshness }, valid: this.valid,
      configDiagnostics: this.configDiagnosticsOut,
    };
  }

  private definitions(): void {
    const { truth, trace, git } = this.input;
    const issueIds = new Set(truth.issues.map((i) => i.id));
    const branch = git?.state?.branch;
    this.addNode(PROJECT_REF, clean({
      name: truth.config.name,
      currentMilestone: truth.config.currentMilestone ?? undefined,
      git: git?.state === undefined ? undefined : clean({
        headOid: git.state.headOid, branch, detached: git.state.detached,
        branchIssueIds: branch === undefined ? [] : extractIssueKeys(branch).filter((k) => issueIds.has(k)),
      }),
    }), truth.config.location);
    // Definitions the trace accepted (the first of duplicate IDs; DUPLICATE_ID is reported by the loader).
    const accepted = (id: string, location: SourceLocation) => {
      const e = trace.entities.get(id);
      return e !== undefined && compareSourceLocations(e.location, location) === 0;
    };
    for (const m of truth.milestones) {
      if (!accepted(m.id, m.location)) continue;
      this.addNode(definitionRef("milestone", m.id), clean({ title: m.title, state: m.state }), m.location);
      this.addEdge(PROJECT_REF, "CONTAINS", definitionRef("milestone", m.id), "project-truth", { provenance: "declared" });
    }
    for (const r of truth.requirements) {
      if (accepted(r.id, r.location)) this.addNode(definitionRef("requirement", r.id), clean({ title: r.title, status: r.status, milestone: r.milestone ?? undefined, priority: r.priority }), r.location);
    }
    for (const d of truth.decisions) {
      if (accepted(d.id, d.location)) this.addNode(definitionRef("decision", d.id), clean({ decisionKind: d.decisionKind, title: d.title, state: d.state }), d.location);
    }
    for (const c of truth.constraints) {
      if (accepted(c.id, c.location)) this.addNode(definitionRef("decision", c.id), clean({ decisionKind: "constraint", title: c.statement, state: c.state, enforcement: c.enforcement }), c.location);
    }
    // Issue key candidates from commit messages count only when Project Truth has the Issue.
    const issueCommits = git?.history?.issueCommits ?? {};
    for (const i of truth.issues) {
      if (!accepted(i.id, i.location)) continue;
      const found = Object.hasOwn(issueCommits, i.id) ? issueCommits[i.id] : undefined;
      const commits = found === undefined || found.length === 0 ? undefined : [...found];
      this.addNode(definitionRef("issue", i.id), clean({ title: i.title, status: i.status, milestone: i.milestone ?? undefined, commits }), i.location);
    }
    // Declared links (03 추적 관계). SUPERSEDES links on a cycle are dropped.
    const cyclic = this.supersedeCycleEdges();
    for (const link of trace.links) {
      if (link.relation === "SUPERSEDES" && cyclic.has(`${link.from.id}\u0000${link.to.id}`)) continue;
      if (!this.has(link.from) || !this.has(link.to)) continue;
      this.addEdge(link.from, link.relation, link.to, "project-truth", json({ provenance: "declared", declaredAt: link.declaredAt }));
    }
  }

  /** SUPERSEDES edges that lie on a cycle (Tarjan SCC). */
  private supersedeCycleEdges(): Set<string> {
    const next = new Map<string, string[]>();
    for (const l of this.input.trace.links) if (l.relation === "SUPERSEDES") next.set(l.from.id, [...(next.get(l.from.id) ?? []), l.to.id]);
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const component = new Map<string, number>();
    let counter = 0;
    let components = 0;
    const visit = (v: string) => {
      index.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      for (const w of next.get(v) ?? []) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
      if (low.get(v) === index.get(v)) {
        for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
          onStack.delete(w);
          component.set(w, components);
          if (w === v) break;
        }
        components++;
      }
    };
    for (const v of [...next.keys()].sort(compareUtf8)) if (!index.has(v)) visit(v);
    const sizes = new Map<number, number>();
    for (const c of component.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const cyclic = new Set<string>();
    for (const [from, targets] of next) {
      for (const to of targets) {
        const c = component.get(from);
        if (c !== undefined && c === component.get(to) && (sizes.get(c) ?? 0) > 1) cyclic.add(`${from}\u0000${to}`);
      }
    }
    return cyclic;
  }

  private filesAndCode(): void {
    const analyses = new Map(this.input.analyses.map((a) => [a.analysis.path, a] as const));
    const failed = new Set(this.input.failedAnalyses ?? []);
    for (const f of [...this.input.files].sort((a, b) => compareUtf8(a.path, b.path))) {
      // Project Truth files are provenance sources, not application code (Requirement/Decision nodes point to them).
      if (f.path.startsWith(STATE_PREFIX)) continue;
      const analyzed = analyses.get(f.path);
      const ref = fileRef(f.path);
      this.filePaths.add(f.path);
      this.addNode(ref, clean({
        path: f.path, state: f.state, fingerprintMode: f.fingerprintMode,
        language: analyzed?.analysis.language,
        analysis: analyzed !== undefined ? analyzed.analysis.parseStatus : failed.has(f.path) ? "failed" : undefined,
        analyzerVersion: analyzed?.analyzerVersion,
      }), { path: f.path }, f.contentHash);
      this.addEdge(PROJECT_REF, "CONTAINS", ref, "source-analysis", { provenance: "static" });
      if (analyzed !== undefined) this.code(analyzed.analysis, analyzed.analyzerVersion);
    }
  }

  private code(analysis: SourceAnalysis, analyzerVersion: string): void {
    const file = fileRef(analysis.path);
    const byIdentity = new Map<string, AnalyzedSymbol>();
    const topLevel = new Map<string, AnalyzedSymbol[]>();
    for (const s of analysis.symbols) {
      byIdentity.set(s.ref.symbol, s);
      if (s.parent === undefined) topLevel.set(s.name, [...(topLevel.get(s.name) ?? []), s]);
      this.addNode(s.ref, clean({
        name: s.name, qualifiedName: s.qualifiedName, kind: s.kind, exported: s.exported, memberScope: s.memberScope, parent: s.parent,
        additionalLocations: s.additionalLocations, analyzerVersion,
      }), s.location, analysis.contentHash);
      this.addEdge(file, "CONTAINS", s.ref, "source-analysis", { provenance: "static" });
    }
    for (const s of analysis.symbols) {
      const parent = s.parent === undefined ? undefined : byIdentity.get(s.parent);
      if (parent?.kind === "class") this.addEdge(parent.ref, "CONTAINS", s.ref, "source-analysis", { provenance: "static" });
    }
    const byName = new Map<string, AnalyzedTest[]>();
    for (const t of analysis.tests) if (t.kind === "test") byName.set(t.fullName, [...(byName.get(t.fullName) ?? []), t]);
    const tests: AnalyzedTest[] = [];
    for (const [fullName, group] of byName) {
      if (group.length > 1) {
        this.diagnostics.push(createDiagnostic("TEST_ID_CONFLICT", `${group.length} tests named "${fullName}" in ${analysis.path}; none becomes a Test node`, group[0]?.location));
        continue;
      }
      const t = group[0];
      if (t === undefined) continue;
      tests.push(t);
      const ref = testRef(analysis.path, fullName);
      this.addNode(ref, clean({
        name: t.name, fullName, frameworkHint: t.frameworkHint, confidence: t.confidence, modifier: t.modifier, enclosingSuite: t.enclosingSuite, analyzerVersion,
      }), t.location, analysis.contentHash);
      this.addEdge(file, "CONTAINS", ref, "source-analysis", { provenance: "static" });
    }
    const bindings = new Map<string, { ref: ModuleReference; binding: ImportBinding }>();
    for (const ref of analysis.moduleReferences) for (const binding of ref.bindings) bindings.set(binding.local, { ref, binding });
    this.contexts.set(analysis.path, { analysis, analyzerVersion, bindings, byIdentity, topLevel, tests });
  }

  // ---- declared code relations (Requirement.implements / tests, Decision.governs) ----

  private symbolsNamed(qualifiedName: string, paths: readonly string[]): { file: RepoPath; symbol: AnalyzedSymbol }[] {
    const matchers = paths.flatMap((p) => compileRepoPattern(p) ?? []);
    const out: { file: RepoPath; symbol: AnalyzedSymbol }[] = [];
    for (const [file, ctx] of this.contexts) {
      if (matchers.length > 0 && !matchers.some((m) => m(file))) continue;
      for (const s of ctx.analysis.symbols) if (s.qualifiedName === qualifiedName) out.push({ file, symbol: s });
    }
    return out;
  }

  private filesMatching(patterns: readonly string[]): RepoPath[] {
    const matchers = patterns.flatMap((p) => compileRepoPattern(p) ?? []);
    return [...this.filePaths].filter((f) => matchers.some((m) => m(f))).sort(compareUtf8);
  }

  private declaredSymbol(owner: EntityRef, name: string, paths: readonly string[], field: string, at: SourceLocation): SymbolRef | undefined {
    const found = this.symbolsNamed(name, paths);
    if (found.length === 1) return found[0]?.symbol.ref;
    if (this.contexts.size > 0) {
      this.diagnostics.push(createDiagnostic("DECLARED_SYMBOL_UNRESOLVED",
        `${nodeId(owner)} ${field} "${name}" matches ${found.length === 0 ? "no symbol" : `${found.length} symbols`}; no edge`, at));
    }
    return undefined;
  }

  private declaredCodeRelations(): void {
    const { truth } = this.input;
    const allTests = [...this.contexts.entries()].flatMap(([file, ctx]) => ctx.tests.map((t) => ({ file, test: t })));
    const requirementIds = new Set(truth.requirements.map((r) => r.id));
    for (const r of truth.requirements) {
      const req = definitionRef("requirement", r.id);
      if (!this.has(req)) continue;
      for (const f of this.filesMatching(r.implements.paths)) this.addEdge(fileRef(f), "IMPLEMENTS", req, "project-truth", { provenance: "declared", basis: ["implements.paths"] });
      for (const name of r.implements.symbols) {
        const s = this.declaredSymbol(req, name, r.implements.paths, "implements.symbols", r.location);
        if (s !== undefined) this.addEdge(s, "IMPLEMENTS", req, "project-truth", { provenance: "declared", basis: ["implements.symbols"] });
      }
      const patterns = r.tests.map(wildcard);
      for (const { file, test } of allTests) {
        if (patterns.some((p) => p.test(test.fullName))) this.addEdge(req, "VALIDATED_BY", testRef(file, test.fullName), "project-truth", { provenance: "declared", basis: ["tests"] });
      }
    }
    // A Requirement ID written in a test name is an explicit declaration too (04).
    for (const { file, test } of allTests) {
      for (const id of extractIssueKeys(test.fullName)) {
        if (requirementIds.has(id) && this.has(definitionRef("requirement", id))) {
          this.addEdge(definitionRef("requirement", id), "VALIDATED_BY", testRef(file, test.fullName), "project-truth", { provenance: "declared", basis: ["test-name"] });
        }
      }
    }
    for (const d of truth.decisions) {
      const dec = definitionRef("decision", d.id);
      if (!this.has(dec)) continue;
      for (const f of this.filesMatching(d.governs.paths)) this.addEdge(dec, "GOVERNS", fileRef(f), "project-truth", { provenance: "declared", basis: ["governs.paths"] });
      for (const name of d.governs.symbols) {
        const s = this.declaredSymbol(dec, name, [], "governs.symbols", d.location);
        if (s !== undefined) this.addEdge(dec, "GOVERNS", s, "project-truth", { provenance: "declared", basis: ["governs.symbols"] });
      }
    }
  }

  // ---- modules and calls ----

  /** The module result of one reference (precomputed per file before any call is resolved). */
  private moduleResult(from: RepoPath, ref: ModuleReference): ModuleResolution {
    return this.moduleResults.get(from)?.get(ref)
      ?? this.input.moduleResolver.resolve({ fromPath: from, specifier: ref.specifier, kind: ref.kind });
  }

  /** Module results for every analyzed file: stored results when the Indexer allows it, else TypeScript resolution. */
  private resolveModules(): void {
    for (const [path, ctx] of [...this.contexts].sort(([a], [b]) => compareUtf8(a, b))) {
      const refs = ctx.analysis.moduleReferences;
      const previous = this.memo?.previous.get(path);
      let results: readonly ModuleResolution[];
      let configFiles: readonly RepoPath[];
      if (previous !== undefined && this.memo?.reusableModules.has(path) === true && previous.modules.length === refs.length) {
        results = previous.modules;
        configFiles = previous.configFiles;
        this.work.modulesReused += refs.length;
      } else {
        results = refs.map((ref) => this.input.moduleResolver.resolve({ fromPath: path, specifier: ref.specifier, kind: ref.kind }));
        configFiles = this.input.moduleResolver.configFiles(path);
        this.work.modulesRecomputed += refs.length;
        this.work.filesModulesRecomputed++;
      }
      this.moduleResults.set(path, new Map(refs.map((ref, i) => [ref, results[i] as ModuleResolution] as const)));
      this.resolution.set(path, { modules: results, calls: [], exportDependencies: [], configFiles });
    }
  }

  private sameModules(path: RepoPath): boolean {
    const previous = this.memo?.previous.get(path);
    const current = this.resolution.get(path);
    return previous !== undefined && current !== undefined
      && canonicalJson(json({ m: previous.modules }), "modules") === canonicalJson(json({ m: current.modules }), "modules");
  }

  /** A file whose export surface a stored call result may have read has changed. */
  private surfaceChanged(path: RepoPath): boolean {
    return this.memo === undefined || this.memo.changedFiles.has(path) || !this.sameModules(path);
  }

  private callFreshnessOf(path: RepoPath, ctx: FileContext): CallResolutionFreshness {
    const previous = this.memo?.previous.get(path);
    if (this.memo === undefined || previous === undefined) return "missing";
    if (this.memo.callVersionChanged) return "stale-version";
    if (this.memo.changedFiles.has(path)) return "stale-source";
    if (!this.sameModules(path)) return "stale-modules";
    if (previous.exportDependencies.some((d) => this.surfaceChanged(d))) return "stale-dependency";
    return previous.calls.length === ctx.analysis.callSites.length ? "fresh" : "missing";
  }

  /** Stored outcomes with their targets looked up again; undefined when a target no longer exists. */
  private rehydrate(stored: readonly StoredCallOutcome[]): CallOutcome[] | undefined {
    const out: CallOutcome[] = [];
    for (const s of stored) {
      if (s.target === undefined) {
        out.push({ status: s.status, ...(s.reason === undefined ? {} : { reason: s.reason }) });
        continue;
      }
      const symbol = this.contexts.get(s.target.file)?.byIdentity.get(s.target.symbol);
      if (symbol === undefined) return undefined;
      out.push({ status: s.status, ...(s.reason === undefined ? {} : { reason: s.reason }), target: { file: s.target.file, symbol } });
    }
    return out;
  }

  private modulesAndCalls(): void {
    this.resolveModules();
    this.reportConfigDiagnostics();
    for (const [path, ctx] of [...this.contexts].sort(([a], [b]) => compareUtf8(a, b))) {
      const file = fileRef(path);
      for (const ref of ctx.analysis.moduleReferences) {
        const result = this.moduleResult(path, ref);
        this.moduleResolutions.push({ from: path, specifier: ref.specifier, kind: ref.kind, location: ref.location, result });
        if (result.status === "resolved" && result.path !== path && this.filePaths.has(result.path)) {
          const kinds = [ref.kind];
          this.addEdge(file, "IMPORTS", fileRef(result.path), "module-resolution",
            json({ provenance: "static", resolution: result.claim, kinds, typeOnly: ref.typeOnly, declarationOnly: result.declarationOnly, extensionSubstituted: result.extensionSubstituted }),
            (old) => json({
              ...old,
              kinds: [...new Set([...(Array.isArray(old.kinds) ? old.kinds.map(String) : []), ref.kind])].sort(compareUtf8),
              typeOnly: old.typeOnly === true && ref.typeOnly,
            }));
        } else if (result.status === "unresolved" && result.reason === "not-found") {
          this.diagnostics.push(createDiagnostic("MODULE_UNRESOLVED", `"${ref.specifier}" does not resolve to a repository file`, ref.location));
        } else if (result.status === "ambiguous") {
          this.diagnostics.push(createDiagnostic("MODULE_AMBIGUOUS", `"${ref.specifier}" has ${result.candidates.length} candidate files`, ref.location));
        }
      }
    }
    for (const [path, ctx] of [...this.contexts].sort(([a], [b]) => compareUtf8(a, b))) {
      const sites = ctx.analysis.callSites;
      let freshness = this.callFreshnessOf(path, ctx);
      const previous = this.memo?.previous.get(path);
      let outcomes = freshness === "fresh" && previous !== undefined ? this.rehydrate(previous.calls) : undefined;
      if (freshness === "fresh" && outcomes === undefined) freshness = "stale-dependency";
      let exportDependencies = previous?.exportDependencies ?? [];
      if (outcomes === undefined) {
        const deps = new Set<RepoPath>();
        outcomes = sites.map((call) => this.resolveCall(path, ctx, call, deps));
        deps.delete(path);
        exportDependencies = [...deps].sort(compareUtf8);
        this.work.callsRecomputed += sites.length;
        this.work.filesCallsRecomputed++;
      } else {
        this.work.callsReused += sites.length;
      }
      this.callFreshness.set(path, freshness);
      const resolved = outcomes;
      const current = this.resolution.get(path);
      if (current !== undefined) {
        this.resolution.set(path, {
          ...current,
          calls: resolved.map((o) => ({
            status: o.status, ...(o.reason === undefined ? {} : { reason: o.reason }),
            ...(o.target === undefined ? {} : { target: { file: o.target.file, symbol: o.target.symbol.ref.symbol } }),
          })),
          exportDependencies,
        });
      }
      const exactTargets: { call: CallSite; target: Target }[] = [];
      sites.forEach((call, i) => {
        const outcome = resolved[i] as CallOutcome;
        this.calls[outcome.status]++;
        const target = outcome.target;
        this.callResolutions.push({
          path, calleeText: call.calleeText, location: call.location, status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          ...(target === undefined ? {} : { target: target.symbol.ref }),
          ...(call.enclosingSymbol === undefined ? {} : { source: call.enclosingSymbol }),
        });
        if (outcome.status === "ambiguous") {
          this.diagnostics.push(createDiagnostic("CALL_AMBIGUOUS", `"${call.calleeText}" has more than one candidate target; no edge`, call.location));
        }
        if (outcome.status !== "exact" || target === undefined) return;
        exactTargets.push({ call, target });
        if (call.enclosingSymbol === undefined) {
          this.calls.exactWithoutSourceSymbol++;
          return;
        }
        const declarationOnly = /\.d\.[cm]?ts$/u.test(target.file);
        this.addEdge(call.enclosingSymbol, "CALLS", target.symbol.ref, "call-resolution", json({ provenance: "static", resolution: "exact", callSites: 1, declarationOnly }),
          (old) => json({ ...old, callSites: (typeof old.callSites === "number" ? old.callSites : 0) + 1 }));
      });
      this.validatedByCalls(path, ctx, exactTargets);
    }
  }

  /**
   * Diagnostics of every nearest config an analyzed file uses. A full build reads each of them; an
   * incremental build that did not read one again reports its stored diagnostics, so both report
   * the same persistent diagnostics (T08.1).
   */
  private reportConfigDiagnostics(): void {
    const heads = new Set<RepoPath>();
    for (const r of this.resolution.values()) if (r.configFiles[0] !== undefined) heads.add(r.configFiles[0]);
    const resolver = this.input.moduleResolver;
    for (const head of [...heads].sort(compareUtf8)) {
      const list = resolver.configDiagnostics(head) ?? this.memo?.configDiagnostics.get(head) ?? resolver.configDiagnostics(head, { load: true }) ?? [];
      this.configDiagnosticsOut.set(head, list);
      this.diagnostics.push(...list);
    }
  }

  /** VALIDATED_BY Symbol → Test: exact calls inside the test's range to code outside test files. */
  private validatedByCalls(path: RepoPath, ctx: FileContext, exact: readonly { call: CallSite; target: Target }[]): void {
    for (const { call, target } of exact) {
      const test = this.innermostTest(ctx.tests, call.location);
      if (test === undefined) continue;
      const targetCtx = this.contexts.get(target.file);
      if (TEST_FILE.test(target.file) || (targetCtx?.analysis.tests.length ?? 0) > 0) continue; // helpers, not validated code
      this.addEdge(target.symbol.ref, "VALIDATED_BY", testRef(path, test.fullName), "test", { provenance: "static", basis: ["exact-call"] });
    }
  }

  private innermostTest(tests: readonly AnalyzedTest[], at: SourceLocation): AnalyzedTest | undefined {
    const before = (l1: number, c1: number, l2: number, c2: number) => l1 < l2 || (l1 === l2 && c1 <= c2);
    const inside = (outer: SourceLocation, inner: SourceLocation) =>
      before(outer.startLine ?? 0, outer.startColumn ?? 0, inner.startLine ?? 0, inner.startColumn ?? 0)
      && before(inner.endLine ?? 0, inner.endColumn ?? 0, outer.endLine ?? 0, outer.endColumn ?? 0);
    let best: AnalyzedTest | undefined;
    for (const t of tests) if (inside(t.location, at) && (best === undefined || inside(best.location, t.location))) best = t;
    return best;
  }

  private fromExport(lookup: ExportLookup, kind: CallSite["kind"]): CallOutcome {
    if (lookup.status === "ambiguous") return { status: "ambiguous", reason: "export-ambiguous" };
    if (lookup.status !== "symbol") return { status: "unresolved", reason: lookup.status === "not-symbol" ? "export-not-symbol" : "export-unresolved" };
    return CALLABLE_BY_KIND[kind].has(lookup.symbol.kind) ? { status: "exact", target: lookup } : { status: "unresolved", reason: "target-not-callable" };
  }

  /** Export lookup that records the files it read into deps (TASK-008 export dependencies). */
  private lookupExport(file: RepoPath, name: string, deps: Set<RepoPath>): ExportLookup {
    const r = this.exportIndex.lookupWithDependencies(file, name);
    for (const d of r.dependencies) deps.add(d);
    return r.result;
  }

  private viaImport(path: RepoPath, entry: { ref: ModuleReference; binding: ImportBinding }, member: string | undefined, kind: CallSite["kind"], deps: Set<RepoPath>): CallOutcome {
    const { ref, binding } = entry;
    if (binding.typeOnly) return { status: "unresolved", reason: "type-only-binding" };
    const module = this.moduleResult(path, ref);
    if (module.status !== "resolved") return { status: "unresolved", reason: module.status === "external" ? "external-module" : "module-unresolved" };
    if (binding.imported === "*") {
      // Namespace object: import * as ns. The CommonJS module object (require) has no export index.
      if (ref.kind !== "import" || member === undefined) return { status: "unresolved", reason: "namespace-call" };
      return this.fromExport(this.lookupExport(module.path, member, deps), kind);
    }
    const imported = this.lookupExport(module.path, binding.imported, deps);
    if (member === undefined) return this.fromExport(imported, kind);
    // Imported class, static member: import { User } from "./user"; User.load().
    if (imported.status !== "symbol" || imported.symbol.kind !== "class") return { status: "unresolved", reason: "receiver-type-unknown" };
    return this.staticMember(imported.file, imported.symbol, member);
  }

  private staticMember(file: RepoPath, cls: AnalyzedSymbol, member: string): CallOutcome {
    const symbol = this.contexts.get(file)?.byIdentity.get(`${cls.ref.symbol}.static.${member}`);
    return symbol?.kind === "method" ? { status: "exact", target: { file, symbol } } : { status: "unresolved", reason: "static-member-not-found" };
  }

  /** Exact resolution from syntax facts only (no type checker). Anything else is unresolved or ambiguous. */
  private resolveCall(path: RepoPath, ctx: FileContext, call: CallSite, deps: Set<RepoPath>): CallOutcome {
    const names = call.calleePath;
    if (names === undefined || names.length === 0) return { status: "unresolved", reason: "computed-callee" };
    if (call.rootLocal === true) return { status: "unresolved", reason: "local-binding" };
    const [root = "", second, ...rest] = names;
    if (rest.length > 0) return { status: "unresolved", reason: "receiver-type-unknown" };
    if (root === "super") return { status: "unresolved", reason: "super" };
    if (root === "this") {
      if (second === undefined || call.thisBinding !== "member") return { status: "unresolved", reason: "this-not-member" };
      const enclosing = call.enclosingSymbol === undefined ? undefined : ctx.byIdentity.get(call.enclosingSymbol.symbol);
      if (enclosing?.memberScope !== "instance" || enclosing.parent === undefined) return { status: "unresolved", reason: "this-receiver-unknown" };
      const target = ctx.byIdentity.get(`${enclosing.parent}.${second}`);
      return target?.kind === "method" ? { status: "exact", target: { file: path, symbol: target } } : { status: "unresolved", reason: "member-not-found" };
    }
    const imported = ctx.bindings.get(root);
    if (imported !== undefined) return this.viaImport(path, imported, second, call.kind, deps);
    const local = (ctx.topLevel.get(root) ?? []);
    if (second === undefined) {
      const callable = local.filter((s) => CALLABLE_BY_KIND[call.kind].has(s.kind));
      if (callable.length > 1) return { status: "ambiguous", reason: "same-file-candidates" };
      const only = callable[0];
      return only === undefined ? { status: "unresolved", reason: local.length > 0 ? "target-not-callable" : "no-candidate" } : { status: "exact", target: { file: path, symbol: only } };
    }
    // Local class static member: User.load().
    const classes = local.filter((s) => s.kind === "class");
    if (classes.length > 1) return { status: "ambiguous", reason: "same-file-candidates" };
    const cls = classes[0];
    if (cls === undefined || local.length !== 1) return { status: "unresolved", reason: "receiver-type-unknown" };
    return this.staticMember(path, cls, second);
  }

  // ---- annotations ----

  private annotationRelations(): void {
    for (const [path, ctx] of [...this.contexts].sort(([a], [b]) => compareUtf8(a, b))) {
      if (ctx.analysis.annotations.length === 0) continue;
      const candidates: AttachmentCandidate<{ kind: "symbol"; ref: SymbolRef } | { kind: "test"; fullName: string }>[] = [
        ...ctx.analysis.symbols.map((s) => ({ value: { kind: "symbol" as const, ref: s.ref }, location: s.location })),
        ...ctx.tests.map((t) => ({ value: { kind: "test" as const, fullName: t.fullName }, location: t.location })),
      ];
      const text = this.input.sourceText(path);
      for (const annotation of ctx.analysis.annotations) {
        const attached = attachAnnotation(annotation.location, candidates, text);
        const target = attached.kind === "file" ? { kind: "file" as const } : attached.value;
        for (const id of annotation.ids) {
          const entity = this.input.trace.entities.get(id);
          if (entity === undefined) {
            this.annotations.unknownId++;
            this.diagnostics.push(createDiagnostic("ANNOTATION_TARGET_UNKNOWN", `"duo: ${id}" names no Project Truth definition`, annotation.location));
            continue;
          }
          if (entity.ref.type !== "requirement") {
            this.annotations.unsupportedId++;
            this.diagnostics.push(createDiagnostic("ANNOTATION_TARGET_UNSUPPORTED", `"duo: ${id}" is a ${entity.ref.type}; code annotations link Requirements only`, annotation.location));
            continue;
          }
          const metadata = json({ provenance: "static", basis: ["annotation"], annotation: annotation.location });
          if (target.kind === "symbol") this.addEdge(target.ref, "IMPLEMENTS", entity.ref, "annotation", metadata);
          else if (target.kind === "test") this.addEdge(entity.ref, "VALIDATED_BY", testRef(path, target.fullName), "annotation", metadata);
          else this.addEdge(fileRef(path), "IMPLEMENTS", entity.ref, "annotation", metadata);
          this.annotations[target.kind]++;
        }
      }
    }
  }

  // ---- history ----

  private coChange(): void {
    for (const c of this.input.git?.history?.coChange ?? []) {
      if (!this.filePaths.has(c.a) || !this.filePaths.has(c.b)) continue;
      const metadata = { provenance: "git", correlation: "historical", count: c.count };
      this.addEdge(fileRef(c.a), "CHANGED_WITH", fileRef(c.b), "git-history", metadata);
      this.addEdge(fileRef(c.b), "CHANGED_WITH", fileRef(c.a), "git-history", metadata);
    }
  }

  // ---- validation ----

  private validate(): void {
    for (const edge of this.edges.values()) {
      const from = this.nodes.get(nodeId(edge.from));
      const to = this.nodes.get(nodeId(edge.to));
      if (from === undefined || to === undefined || !isEdgeEndpointAllowed(edge.type, edge.from.type, edge.to.type)) {
        this.valid = false;
        this.diagnostics.push(createDiagnostic("EDGE_ENDPOINT_INVALID",
          `${nodeId(edge.from)} -${edge.type}-> ${nodeId(edge.to)} ${from === undefined || to === undefined ? "points to a missing node" : "is not allowed by 04"}`));
      }
    }
  }

  private stats(nodes: readonly GraphNodeInput[], edges: readonly GraphEdgeInput[]): GraphBuildStats {
    const nodeCounts = Object.fromEntries(ENTITY_TYPES.map((t) => [t, 0])) as Record<EntityType, number>;
    for (const n of nodes) nodeCounts[n.ref.type]++;
    const edgeCounts = Object.fromEntries(GRAPH_EDGE_TYPES.map((t) => [t, 0])) as Record<GraphEdgeType, number>;
    for (const e of edges) edgeCounts[e.type]++;
    const modules: Record<ModuleResolutionStatus, number> = { resolved: 0, external: 0, unresolved: 0, ambiguous: 0, unsupported: 0 };
    for (const m of this.moduleResolutions) modules[m.result.status]++;
    return { nodes: nodeCounts, edges: edgeCounts, modules, calls: { ...this.calls }, annotations: { ...this.annotations } };
  }
}

/**
 * Plans the Project Graph from facts. Does not write; see applyGraphPlan(). Without a memo every
 * resolution is computed (full build). With a memo, valid stored resolutions are reused and the plan
 * is the same as the full build's.
 */
export function buildGraphPlan(input: GraphBuildInput, memo?: ResolutionMemo): GraphBuildPlan {
  return new Builder(input, memo).build();
}
