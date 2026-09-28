/**
 * Deterministic findings at adoption (T14.1): what already violates confirmed Truth when DUO starts to
 * manage the project. Only rules DUO can check without a task or an LLM: Decision forbids (paths,
 * symbols, dependencies), unresolved declared references (the Indexer's diagnostics) and local
 * External Source drift. R-SCOPE needs a task and is not a baseline rule. Paths changed in the dirty
 * working tree are not baselined: those changes stay changes to review.
 */
import { isSecretFileName } from "@duo-director/analyzer";
import {
  compareSourceHash, compareUtf8, compileRepoPattern, externalSourceSlice, isRemoteSourcePath, normalizeRepoPath, readSourceFile,
  type Diagnostic, type EntityType, type ProjectTruth, type RepoPath, type SourceRef,
} from "@duo-director/core";
import type { GraphNode, GraphReader } from "@duo-director/graph";
import { wildcard } from "../relevance/policy.js";
import { isActive } from "../review/claims.js";
import { dependencyNames } from "../review/rules.js";
import { declaredReferenceParts, dependencyOffending, sourceOffending, violationKey } from "./key.js";
import type { BaselineFinding, BaselineRule } from "./types.js";

function allNodes(graph: GraphReader, type: EntityType): GraphNode[] {
  const out: GraphNode[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = graph.listNodes({ type, limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
    out.push(...page);
    if (page.length < 1000) return out;
    afterId = page[page.length - 1]?.id;
  }
}

type External = Extract<SourceRef, { kind: "external" }>;
const externals = (s: readonly SourceRef[]) => s.filter((x): x is External => x.kind === "external");

export interface FindingsInput {
  readonly root: string;
  readonly truth: ProjectTruth;
  readonly graph: GraphReader;
  readonly stateDiagnostics: readonly Diagnostic[];
  /** Dirty paths: not baselined. */
  readonly skip: ReadonlySet<string>;
}

export function baselineFindings(input: FindingsInput): { readonly findings: BaselineFinding[]; readonly skipped: number } {
  const found = new Map<string, BaselineFinding>();
  let skipped = 0;
  const add = (rule: BaselineRule, governing: string, offending: string, extra: { path?: RepoPath; enforced?: boolean }) => {
    if (extra.path !== undefined && input.skip.has(extra.path)) { skipped++; return; }
    const key = violationKey(rule, governing, offending);
    if (!found.has(key)) found.set(key, { key, rule, governing, offending, ...extra });
  };

  const decisions = input.truth.decisions.filter((d) => isActive(d) && d.forbids.paths.length + d.forbids.symbols.length + d.forbids.dependencies.length > 0);
  if (decisions.length > 0) {
    const files = allNodes(input.graph, "file");
    const symbols = allNodes(input.graph, "symbol");
    const manifests = files.filter((f) => f.ref.type === "file" && (f.ref.path === "package.json" || f.ref.path.endsWith("/package.json")));
    const deps = new Map(manifests.map((m) => [m.ref.type === "file" ? m.ref.path : "", dependencyNames(readSourceFile(input.root, m.ref.type === "file" ? m.ref.path : "").value)] as const));
    for (const d of decisions) {
      const enforced = d.enforcement === "block";
      const paths = d.forbids.paths.flatMap((p) => compileRepoPattern(p) ?? []);
      for (const f of files) if (f.ref.type === "file" && paths.some((m) => m(f.ref.type === "file" ? f.ref.path : ("" as RepoPath)))) add("decision-forbids", d.id, f.id, { path: f.ref.path, enforced });
      const patterns = d.forbids.symbols.map(wildcard);
      for (const s of symbols) {
        const qn = String(s.payload.qualifiedName ?? "");
        if (s.ref.type === "symbol" && patterns.some((re) => re.test(qn))) add("decision-forbids", d.id, s.id, { path: s.ref.path, enforced });
      }
      for (const [manifest, names] of deps) {
        for (const n of [...names].filter((x) => d.forbids.dependencies.includes(x))) add("decision-forbids", d.id, dependencyOffending(manifest, n), { path: manifest as RepoPath, enforced });
      }
    }
  }

  for (const diag of input.stateDiagnostics.filter((x) => x.code === "DECLARED_SYMBOL_UNRESOLVED")) {
    const parts = declaredReferenceParts(diag.message);
    if (parts !== undefined) add("declared-reference", parts.governing, parts.offending, diag.source === undefined ? {} : { path: diag.source.path as RepoPath });
  }

  const items: { id: string; sources: readonly External[] }[] = [
    ...input.truth.requirements.map((r) => ({ id: r.id, sources: externals(r.sources) })),
    ...input.truth.decisions.filter(isActive).map((d) => ({ id: d.id, sources: externals(d.sources) })),
    ...input.truth.constraints.filter((c) => c.state === "confirmed").map((c) => ({ id: c.id, sources: externals(c.sources) })),
    ...(input.truth.vision?.status === "confirmed" ? [{ id: input.truth.vision.location.path, sources: externals(input.truth.vision.sources) }] : []),
  ];
  for (const item of items) {
    for (const src of item.sources) {
      const p = isRemoteSourcePath(src.path) ? undefined : normalizeRepoPath(src.path).value;
      if (p === undefined || isSecretFileName(p)) continue;
      const text = readSourceFile(input.root, p).value;
      if (text === undefined) continue;
      const slice = externalSourceSlice(p, text, src.section);
      const drifted = slice.status === "section-missing" || (slice.status === "ok" && compareSourceHash(src.hash, slice.hash) === "mismatch");
      if (drifted) add("external-source-drift", item.id, sourceOffending(p, src.section), { path: p });
    }
  }
  return { findings: [...found.values()].sort((a, b) => compareUtf8(a.key, b.key)), skipped };
}
