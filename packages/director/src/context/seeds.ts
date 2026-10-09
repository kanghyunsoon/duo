/**
 * Seed resolution (05 §1). Deterministic signals only: exact definition IDs (Issue keys included,
 * any letter case), exact file paths, exact symbol names, and BM25 keyword matching over Project
 * Truth titles and bodies, symbol names and file paths. No LLM, no embeddings. When the signals
 * cannot choose, the result says so (ambiguities) instead of guessing.
 *
 * The task text is only compared with names already in memory; it never becomes a path to open,
 * a shell argument or SQL.
 */
import {
  compareUtf8, definitionRef, fileRef, isDefinitionId, normalizeRepoPath, PROPOSAL_ID_PATTERN, type DefinitionType, type EntityRef, type EntityType, type ProjectTruth, type RepoPath,
} from "@duo-director/core";
import type { GraphNode, GraphReader } from "@duo-director/graph";
import { searchTerms } from "../relevance/terms.js";
import { NO_CALLABLE_GROUPS, oneGroup, type CallableGroups } from "./callables.js";
import { KEYWORD, SEED_STRENGTH, SYMBOL_NAME_MAX_MATCHES } from "./policy.js";
import type { ContextSeed, SeedAmbiguity, SeedMatch, SeedOption, SeedResolution } from "./types.js";

export interface WeightedSeed extends ContextSeed {
  readonly strength: number;
}

export interface SeedResult extends SeedResolution {
  readonly weighted: readonly WeightedSeed[];
  /** Proposal IDs written in the task (P-###). Proposals are not graph nodes. */
  readonly proposalIds: readonly string[];
}

const DEFINITION_TYPES_BY_LOOKUP: readonly DefinitionType[] = ["requirement", "decision", "issue", "milestone"];

/** Display reference of a node: definition ID, path, or path#name. */
export function refOfNode(node: Pick<GraphNode, "ref">): string {
  const ref = node.ref;
  switch (ref.type) {
    case "project": return "project";
    case "file": return ref.path;
    case "symbol": return `${ref.path}#${ref.symbol}`;
    case "test": return `${ref.path}#${ref.name}`;
    default: return ref.id;
  }
}

/**
 * The task tokens BM25 reads: not definition or proposal IDs, and not tokens consumed by an exact seed. exactTokens holds
 * the tokens that resolved to an existing File as a path seed (C249, T46) or to a Symbol (qualified name, unique name or
 * one callable group, C251, T50). Other words, including path-like or name-like tokens that matched nothing or were
 * ambiguous, stay keyword input.
 */
export function keywordQueryTokens(tokens: readonly string[], idTokens: ReadonlySet<string>, exactTokens: ReadonlySet<string>): string[] {
  return tokens.filter((t) => !idTokens.has(t) && !exactTokens.has(t));
}

const SEPARATORS = /[\s,;:!?()[\]{}<>"'`]+/u;

function rawTokens(task: string): string[] {
  return taskWords(task).map((w) => w.token);
}

interface TaskWord {
  /** The token every other signal reads (IDs, names, BM25): surrounding dots removed. */
  readonly token: string;
  /**
   * The same word as a path is written (C252, T47): only trailing sentence dots removed, so a leading "./" or ".\\"
   * survives and reaches normalizeRepoPath. Other leading dots are removed as in token.
   */
  readonly pathText: string;
}

function taskWords(task: string): TaskWord[] {
  return task.split(SEPARATORS).map((w) => {
    const token = w.replace(/^[.]+|[.]+$/gu, "");
    const trimmed = w.replace(/[.]+$/u, "");
    return { token, pathText: /^\.[\\/]/u.test(trimmed) ? trimmed : token };
  }).filter((w) => w.token.length > 0);
}

/**
 * The canonical RepoPath a task word names, when it is written as a repository-relative path with at least one
 * separator: "/" or "\\", optionally after "./" or ".\\" (C252, T47). core normalizeRepoPath decides; absolute paths and
 * paths leaving the repository are not paths here. A root file without a separator is not a path signal.
 */
function pathOf(pathText: string): RepoPath | undefined {
  if (!pathText.includes("/") && !pathText.includes("\\")) return undefined;
  return normalizeRepoPath(pathText).value;
}

/** A symbol name or qualified name the task can name (one token). */
const NAME_TOKEN = /^[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*$/u;

/**
 * The path, written as is in a task, is read as a path seed: one word with a separator that normalizes to a
 * repository-relative RepoPath (T26.2 remediation; C252: "./", ".\\" and "\\" spellings too). Whether the File exists is
 * decided at resolution.
 */
export function isPathSignal(path: string): boolean {
  const words = taskWords(path);
  return words.length === 1 && words[0]?.pathText === path && pathOf(path) !== undefined;
}

/** The name, written as is in a task, is read as a symbol name and not as an ID (T26.2 remediation). */
export function isNameSignal(name: string): boolean {
  const tokens = rawTokens(name);
  const upper = name.toUpperCase();
  return tokens.length === 1 && tokens[0] === name && NAME_TOKEN.test(name) && name.length >= 3 && !isDefinitionId(upper) && !PROPOSAL_ID_PATTERN.test(upper);
}

function listAll(store: GraphReader, type: EntityType): GraphNode[] {
  const out: GraphNode[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = store.listNodes({ type, limit: 1000, ...(afterId === undefined ? {} : { afterId }) });
    out.push(...page);
    if (page.length < 1000) return out;
    afterId = page[page.length - 1]?.id;
  }
}

interface KeywordDoc {
  readonly node: GraphNode;
  readonly kind: string;
  readonly title: string;
  readonly terms: readonly string[];
}

function keywordDocs(truth: ProjectTruth, store: GraphReader, symbols: readonly GraphNode[], files: readonly GraphNode[]): KeywordDoc[] {
  const docs: KeywordDoc[] = [];
  const push = (type: DefinitionType, id: string, kind: string, title: string, text: string) => {
    const node = store.getNode(definitionRef(type, id));
    if (node !== undefined) docs.push({ node, kind, title, terms: searchTerms(text) });
  };
  for (const r of truth.requirements) push("requirement", r.id, "requirement", r.title, `${r.title} ${r.description}`);
  for (const d of truth.decisions) push("decision", d.id, "decision", d.title, `${d.title} ${d.question} ${d.answer}`);
  for (const c of truth.constraints) push("decision", c.id, "constraint", c.statement, `${c.statement} ${c.match.keywords.join(" ")}`);
  for (const i of truth.issues) push("issue", i.id, "issue", i.title, `${i.title} ${i.description}`);
  for (const m of truth.milestones) push("milestone", m.id, "milestone", m.title, m.title);
  for (const n of symbols) docs.push({ node: n, kind: "symbol", title: String(n.payload.qualifiedName ?? ""), terms: searchTerms(String(n.payload.qualifiedName ?? "")) });
  for (const n of files) docs.push({ node: n, kind: "file", title: refOfNode(n), terms: searchTerms(refOfNode(n)) });
  return docs;
}

/** BM25 over the documents for the query terms. Result: (doc, score) with score > 0, best first, ties by id. */
function bm25(docs: readonly KeywordDoc[], query: readonly string[]): { doc: KeywordDoc; score: number }[] {
  const q = [...new Set(query)];
  if (q.length === 0 || docs.length === 0) return [];
  const avg = docs.reduce((n, d) => n + d.terms.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.terms)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const out: { doc: KeywordDoc; score: number }[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of q) {
      const n = df.get(t);
      if (n === undefined) continue;
      let tf = 0;
      for (const x of d.terms) if (x === t) tf++;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * (tf * (KEYWORD.k1 + 1)) / (tf + KEYWORD.k1 * (1 - KEYWORD.b + KEYWORD.b * (d.terms.length / avg)));
    }
    if (score > 0) out.push({ doc: d, score });
  }
  return out.sort((a, b) => b.score - a.score || compareUtf8(a.doc.node.id, b.doc.node.id));
}

function option(node: GraphNode): SeedOption {
  const title = node.payload.title ?? node.payload.qualifiedName;
  return { id: node.id, ref: refOfNode(node), kind: node.type, ...(typeof title === "string" ? { title } : {}) };
}

/**
 * groups (T24.3, C218): linked C++ declarations and definitions. A name whose candidates are all one
 * group is one logical callable: every member becomes a seed instead of an ambiguity.
 */
export function resolveSeeds(task: string, truth: ProjectTruth, store: GraphReader, explicit: readonly EntityRef[] = [], groups: CallableGroups = NO_CALLABLE_GROUPS): SeedResult {
  const found = new Map<string, WeightedSeed>();
  const add = (node: GraphNode, match: SeedMatch, term: string, strength: number) => {
    const prev = found.get(node.id);
    if (prev === undefined || strength > prev.strength) found.set(node.id, { id: node.id, ref: refOfNode(node), match, term, strength });
  };
  const unresolvedIds = new Set<string>();
  const proposalIds = new Set<string>();
  const ambiguities: SeedAmbiguity[] = [];
  let exact = 0;
  // Caller-named entities (Review diff seeds) come first and are exact.
  for (const ref of explicit) {
    const node = store.getNode(ref);
    if (node !== undefined) { add(node, "diff", refOfNode(node), SEED_STRENGTH.diff); exact++; }
  }

  const words = taskWords(task);
  const tokens = words.map((w) => w.token);
  const idTokens = new Set<string>();
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (PROPOSAL_ID_PATTERN.test(upper)) { proposalIds.add(upper); idTokens.add(token); continue; }
    if (!isDefinitionId(upper)) continue;
    idTokens.add(token);
    const node = DEFINITION_TYPES_BY_LOOKUP.map((t) => store.getNode(definitionRef(t, upper))).find((n) => n !== undefined);
    if (node === undefined) unresolvedIds.add(upper);
    else { add(node, "id", token, SEED_STRENGTH.id); exact++; }
  }

  const symbols = listAll(store, "symbol");
  const files = listAll(store, "file");
  // C249 (T46), C251 (T50): a token that resolved to an existing File or a Symbol as an exact seed is not reused as
  // keyword input; otherwise its words (src, auth, ts ...; session, open ...) pull unrelated files and symbols, and the
  // Decisions governing them, in by BM25. Unresolved and ambiguous tokens stay keyword input.
  const exactTokens = new Set<string>();
  for (const { token, pathText } of words) {
    if (idTokens.has(token)) continue;
    const p = pathOf(pathText);
    const node = p === undefined ? undefined : store.getNode(fileRef(p));
    // term: the path as the task spells it ("./src/a.ts", "src\\a.ts"); ref stays the canonical RepoPath.
    if (node !== undefined) { add(node, "path", pathText, SEED_STRENGTH.path); exact++; exactTokens.add(token); continue; }
    if (token.includes("/")) continue;
    const name = token.replace(/\(\)$/u, "");
    if (!NAME_TOKEN.test(name) || name.length < 3) continue;
    const qualified = symbols.filter((s) => s.payload.qualifiedName === name);
    if (qualified.length === 1 && qualified[0] !== undefined) { add(qualified[0], "symbol", token, SEED_STRENGTH.symbol); exact++; exactTokens.add(token); continue; }
    if (qualified.length > 1 && name.includes(".")) {
      if (oneGroup(groups, qualified)) { for (const n of qualified) add(n, "symbol", token, SEED_STRENGTH.symbol); exact++; exactTokens.add(token); continue; }
      if (qualified.length <= SYMBOL_NAME_MAX_MATCHES) ambiguities.push({ term: name, reason: "qualified-name", options: qualified.map(option) });
      continue;
    }
    const named = qualified.length > 1 ? qualified : symbols.filter((s) => s.payload.name === name);
    if (named.length === 1 && named[0] !== undefined) { add(named[0], "symbol-name", token, SEED_STRENGTH["symbol-name"]); exact++; exactTokens.add(token); }
    else if (oneGroup(groups, named)) { for (const n of named) add(n, "symbol-name", token, SEED_STRENGTH["symbol-name"]); exact++; exactTokens.add(token); }
    else if (named.length > 1 && named.length <= SYMBOL_NAME_MAX_MATCHES) ambiguities.push({ term: name, reason: "symbol-name", options: named.map(option) });
  }

  const ranked = bm25(keywordDocs(truth, store, symbols, files), searchTerms(keywordQueryTokens(tokens, idTokens, exactTokens).join(" ")));
  const best = ranked[0]?.score ?? 0;
  const keyword = ranked.filter((r) => r.score >= best * KEYWORD.minFraction).slice(0, KEYWORD.top);
  if (exact === 0 && ambiguities.length === 0) {
    const top = keyword.filter((r) => r.score === best && r.doc.kind === "requirement");
    if (top.length > 1) {
      ambiguities.push({
        term: task.trim(), reason: "keyword-tie",
        options: top.map((r) => option(r.doc.node)),
      });
    }
  }
  for (const r of keyword) add(r.doc.node, "keyword", r.doc.title, (r.score / best) * SEED_STRENGTH.keyword);

  // Ambiguity decides only when no exact signal exists: an ID, a path or a unique name wins.
  const blocking = exact === 0 ? ambiguities : [];
  const weighted = blocking.length > 0 ? [] : [...found.values()].sort((a, b) => b.strength - a.strength || compareUtf8(a.id, b.id));
  return {
    weighted,
    seeds: weighted.map(({ id, ref, match, term }) => ({ id, ref, match, term })),
    ambiguities: blocking,
    unresolvedIds: [...unresolvedIds].sort(compareUtf8),
    proposalIds: [...proposalIds].sort(compareUtf8),
  };
}
