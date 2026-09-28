/**
 * HEAD baseline evaluator (T15.1). With HEAD_BASELINE the baseline repository state is exactly the
 * HEAD tree, so findings are evaluated there, not in the working-tree Graph. Bounded, one-off, no
 * historical GraphStore:
 *
 *   HEAD tree (Git ls-tree) → files the index would consider → for paths whose working tree differs
 *   from HEAD (modified, staged, deleted, conflicted) the HEAD blob through the existing
 *   LanguageAnalyzer; every other path equals HEAD, so its current Graph symbols are HEAD's
 *   → Decision forbids, declared references, local SourceRef drift → violation keys
 *
 * Files only in the working tree (untracked) are not in HEAD and never baseline findings; tracked
 * files deleted in the working tree are. A language without an analyzer gives file-level facts only
 * (limitation), never an error.
 */
import { isSecretFileName, type AnalyzerRegistry, type GitProvider } from "@duo-director/analyzer";
import {
  canonicalSourceText, compareSourceHash, compareUtf8, compileRepoPattern, externalSourceSlice, fileRef, isRemoteSourcePath, nodeId,
  normalizeRepoPath, readSourceFile, STATE_DIR_NAME, type Diagnostic, type ProjectTruth, type RepoPath, type SourceRef,
} from "@duo-director/core";
import type { GraphReader } from "@duo-director/graph";
import { wildcard } from "../relevance/policy.js";
import { isActive } from "../review/claims.js";
import { dependencyNames } from "../review/rules.js";
import { declaredReferenceParts, dependencyOffending, sourceOffending, violationKey } from "./key.js";
import type { BaselineFinding, BaselineRule } from "./types.js";

export interface HeadFindingsInput {
  readonly root: string;
  readonly truth: ProjectTruth;
  readonly graph: GraphReader;
  readonly git: GitProvider;
  readonly registry: AnalyzerRegistry;
  /** Persistent diagnostics of the current index (the working-tree state). */
  readonly stateDiagnostics: readonly Diagnostic[];
  /** Tracked paths whose working tree or index differs from HEAD. */
  readonly divergent: ReadonlySet<string>;
}

interface HeadSymbol { readonly id: string; readonly path: RepoPath; readonly qualifiedName: string }

type External = Extract<SourceRef, { kind: "external" }>;
const externals = (s: readonly SourceRef[]) => s.filter((x): x is External => x.kind === "external");
const decoder = new TextDecoder("utf-8");

export async function headBaselineFindings(input: HeadFindingsInput): Promise<{ readonly findings: BaselineFinding[]; readonly limitations: string[] }> {
  const limitations = new Set<string>();
  const provenance = await input.git.blobProvenance();
  const include = input.truth.config.index.include.flatMap((p) => compileRepoPattern(p) ?? []);
  const exclude = input.truth.config.index.exclude.flatMap((p) => compileRepoPattern(p) ?? []);
  const headFiles = (provenance.value ?? []).filter((p) => p.headBlobOid !== undefined).map((p) => p.path)
    .filter((p) => !p.startsWith(`${STATE_DIR_NAME}/`) && !isSecretFileName(p) && !exclude.some((m) => m(p)) && (include.length === 0 || include.some((m) => m(p))));
  const inHead = new Set<string>(headFiles);
  const headText = async (p: RepoPath): Promise<string | undefined> => {
    const blob = await input.git.readBlob("HEAD", p);
    return blob.value === undefined ? undefined : canonicalSourceText(decoder.decode(blob.value));
  };

  const found = new Map<string, BaselineFinding>();
  const add = (rule: BaselineRule, governing: string, offending: string, extra: { path?: RepoPath; enforced?: boolean }) => {
    const key = violationKey(rule, governing, offending);
    if (!found.has(key)) found.set(key, { key, rule, governing, offending, ...extra });
  };

  // Symbols of HEAD: the current Graph for paths equal to HEAD, the analyzer for divergent ones.
  const decisions = input.truth.decisions.filter((d) => isActive(d) && d.forbids.paths.length + d.forbids.symbols.length + d.forbids.dependencies.length > 0);
  const declared = input.stateDiagnostics.filter((x) => x.code === "DECLARED_SYMBOL_UNRESOLVED");
  const needSymbols = decisions.some((d) => d.forbids.symbols.length > 0) || (declared.length > 0 && input.divergent.size > 0);
  const symbols: HeadSymbol[] = [];
  if (needSymbols) {
    let afterId: string | undefined;
    for (;;) {
      const page = input.graph.listNodes({ type: "symbol", limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
      for (const n of page) {
        if (n.ref.type === "symbol" && inHead.has(n.ref.path) && !input.divergent.has(n.ref.path)) symbols.push({ id: n.id, path: n.ref.path, qualifiedName: String(n.payload.qualifiedName ?? "") });
      }
      if (page.length < 1000) break;
      afterId = page[page.length - 1]?.id;
    }
    for (const p of headFiles.filter((f) => input.divergent.has(f)).sort(compareUtf8)) {
      if (input.registry.analyzerFor(p) === undefined) {
        if (/\.[A-Za-z0-9]+$/u.test(p) && !/\.(?:md|json|ya?ml|txt|lock)$/iu.test(p)) limitations.add("head-symbols-unsupported-language");
        continue;
      }
      const blob = await input.git.readBlob("HEAD", p);
      if (blob.value === undefined) continue;
      const analysis = input.registry.analyze({ path: p, content: blob.value });
      for (const s of analysis.value?.symbols ?? []) symbols.push({ id: nodeId(s.ref), path: p, qualifiedName: s.qualifiedName });
    }
  }

  for (const d of decisions) {
    const enforced = d.enforcement === "block";
    const paths = d.forbids.paths.flatMap((p) => compileRepoPattern(p) ?? []);
    for (const f of headFiles) if (paths.some((m) => m(f))) add("decision-forbids", d.id, nodeId(fileRef(f)), { path: f, enforced });
    const patterns = d.forbids.symbols.map(wildcard);
    for (const s of symbols) if (patterns.some((re) => re.test(s.qualifiedName))) add("decision-forbids", d.id, s.id, { path: s.path, enforced });
    if (d.forbids.dependencies.length > 0) {
      for (const m of headFiles.filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
        const text = input.divergent.has(m) ? await headText(m) : readSourceFile(input.root, m).value;
        for (const n of [...dependencyNames(text)].filter((x) => d.forbids.dependencies.includes(x))) add("decision-forbids", d.id, dependencyOffending(m, n), { path: m, enforced });
      }
    }
  }

  // Declared references: the index's diagnostics are the working tree's; one that a HEAD symbol
  // resolves was introduced by the uncommitted changes and is not a baseline finding.
  if (declared.length > 0 && input.divergent.size > 0) limitations.add("declared-references-approximated-for-divergent-paths");
  for (const diag of declared) {
    const parts = declaredReferenceParts(diag.message);
    if (parts === undefined) continue;
    const name = parts.offending.slice(parts.offending.indexOf(":", 4) + 1);
    if (input.divergent.size > 0 && symbols.filter((s) => s.qualifiedName === name).length === 1) continue;
    add("declared-reference", parts.governing, parts.offending, diag.source === undefined ? {} : { path: diag.source.path as RepoPath });
  }

  // Local External Sources, read from HEAD (a source that is not in HEAD is not baselined).
  const items: { id: string; sources: readonly External[] }[] = [
    ...input.truth.requirements.map((r) => ({ id: r.id, sources: externals(r.sources) })),
    ...input.truth.decisions.filter(isActive).map((d) => ({ id: d.id, sources: externals(d.sources) })),
    ...input.truth.constraints.filter((c) => c.state === "confirmed").map((c) => ({ id: c.id, sources: externals(c.sources) })),
    ...(input.truth.vision?.status === "confirmed" ? [{ id: input.truth.vision.location.path, sources: externals(input.truth.vision.sources) }] : []),
  ];
  for (const item of items) {
    for (const src of item.sources) {
      const p = isRemoteSourcePath(src.path) ? undefined : normalizeRepoPath(src.path).value;
      if (p === undefined || isSecretFileName(p) || !inHead.has(p)) continue;
      const text = await headText(p);
      if (text === undefined) continue;
      const slice = externalSourceSlice(p, text, src.section);
      if (slice.status === "section-missing" || (slice.status === "ok" && compareSourceHash(src.hash, slice.hash) === "mismatch")) add("external-source-drift", item.id, sourceOffending(p, src.section), { path: p });
    }
  }
  return { findings: [...found.values()].sort((a, b) => compareUtf8(a.key, b.key)), limitations: [...limitations].sort(compareUtf8) };
}
