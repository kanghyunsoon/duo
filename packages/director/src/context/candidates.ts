/**
 * Candidate planning (TASK-010): turns the traversal result into ranked Packet candidates with
 * their representations (L1 name, L2 summary, L3 exact source), and collects what is not a
 * ranking candidate: superseded Decisions (history only), pending human decisions and Knowledge
 * Gap signals. No token is counted here; packing (pack.ts) chooses levels within the budget.
 *
 * Confirmed context comes only from Project Truth: Requirements, confirmed Decisions, confirmed
 * Constraints. Proposals, proposed Decisions and draft Constraints are PENDING / NOT CONFIRMED and
 * are never placed in the intent or decision sections (T09.1).
 */
import {
  compareUtf8, pendingDecisionProposals, type Constraint, type Decision, type Diagnostic, type Issue, type Milestone,
  type ProjectTruth, type Proposal, type Requirement, type SourceLocation,
} from "@duo-director/core";
import type { GraphNode } from "@duo-director/graph";
import { matchConstraint, type RelevanceScope, type ScopeEntry } from "../relevance/policy.js";
import { displayRef, type Candidate, type Expansion } from "./expand.js";
import { TIER_ORDER } from "./policy.js";
import { redactSecrets } from "./redact.js";
import type { SourceReader } from "./retrieve.js";
import type { SeedResult } from "./seeds.js";
import { SEED_PROVENANCE, type ContextSeed, type ContextTier, type DecisionHistoryItem, type EvidenceStep, type KnowledgeSignal, type PacketItem, type Representation } from "./types.js";

export interface LevelText {
  readonly level: Representation;
  readonly text: string;
  readonly redactions: number;
}

export interface PlannedItem {
  readonly id: string;
  readonly ref: string;
  readonly kind: PacketItem["kind"];
  readonly tier: ContextTier;
  readonly rank: number;
  readonly mandatory: boolean;
  /** Levels this candidate has, lowest first (L1 always). */
  readonly levels: readonly LevelText[];
  readonly via: PacketItem["via"];
  readonly source?: SourceLocation;
  readonly state?: string;
  /** File the content comes from (per-file diversity, Files Considered). */
  readonly file: string;
}

export interface PlannedPending {
  readonly id: string;
  readonly kind: "proposal" | "decision" | "constraint";
  readonly title: string;
  readonly requiresHumanDecision: boolean;
  readonly relatesTo: readonly string[];
  readonly levels: readonly LevelText[];
  readonly source?: SourceLocation;
  readonly file: string;
}

export interface ContextPlan {
  readonly items: readonly PlannedItem[];
  readonly pending: readonly PlannedPending[];
  readonly history: readonly DecisionHistoryItem[];
  readonly signals: readonly KnowledgeSignal[];
  readonly traversalTruncated: boolean;
  readonly keywordOnly: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

interface Draft {
  readonly id: string;
  readonly ref: string;
  readonly kind: PacketItem["kind"];
  readonly tier: ContextTier;
  readonly score: number;
  readonly depth: number;
  readonly mandatory: boolean;
  readonly levels: readonly LevelText[];
  readonly via: PacketItem["via"];
  readonly source?: SourceLocation;
  readonly state?: string;
  readonly file: string;
}

const EXT_LANG: readonly [RegExp, string][] = [
  [/\.(?:ts|mts|cts)$/u, "ts"], [/\.tsx$/u, "tsx"], [/\.(?:js|mjs|cjs)$/u, "js"], [/\.jsx$/u, "jsx"], [/\.md$/u, "md"], [/\.ya?ml$/u, "yaml"], [/\.json$/u, "json"],
];

function langOf(path: string): string {
  return EXT_LANG.find(([re]) => re.test(path))?.[1] ?? "";
}

/** A fenced block whose fence is longer than any backtick run inside (Markdown-inside-Markdown safe). */
export function fence(text: string, lang: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/gu)) longest = Math.max(longest, m[0].length);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${text}${text.endsWith("\n") ? "" : "\n"}${f}`;
}

function firstParagraph(text: string): string {
  return (text.trim().split(/\n\s*\n/u)[0] ?? "").trim();
}

function levels(parts: readonly (readonly [Representation, string | undefined])[]): LevelText[] {
  const out: LevelText[] = [];
  for (const [level, raw] of parts) {
    if (raw === undefined) continue;
    const r = redactSecrets(raw);
    if (out.length > 0 && out[out.length - 1]?.text === r.text) continue;
    out.push({ level, text: r.text, redactions: r.count });
  }
  return out;
}

function lines(loc: SourceLocation | undefined): string {
  if (loc?.startLine === undefined) return "";
  return loc.endLine === undefined || loc.endLine === loc.startLine ? `:${loc.startLine}` : `:${loc.startLine}-${loc.endLine}`;
}

const TIER_INDEX = new Map(TIER_ORDER.map((t, i) => [t, i] as const));

function codeTier(c: Candidate): ContextTier {
  if (c.steps.some((s) => s.type === "CHANGED_WITH")) return "code-historical";
  const last = c.steps[c.steps.length - 1];
  if (c.depth <= 1 || last?.type === "IMPLEMENTS" || last?.type === "GOVERNS") return "code-direct";
  return "code-structural";
}

/** The traversal candidates as a relevance scope, in rank order (T10.1). */
export function candidateScope(expansion: Expansion, seeds: readonly ContextSeed[], task: string): RelevanceScope {
  const bySeed = new Map(seeds.map((s) => [s.id, s] as const));
  return {
    taskText: task,
    entries: expansion.candidates.map((x): ScopeEntry => {
      const ref = x.node.ref;
      const path = ref.type === "symbol" || ref.type === "file" ? ref.path : undefined;
      const qn = x.node.payload.qualifiedName;
      return {
        id: x.node.id, ref: displayRef(x.node.id), type: x.node.type, hops: x.depth,
        ...(bySeed.has(x.node.id) ? { seed: SEED_PROVENANCE[bySeed.get(x.node.id)?.match ?? "keyword"] } : {}),
        ...(bySeed.has(x.seed) ? { origin: SEED_PROVENANCE[bySeed.get(x.seed)?.match ?? "keyword"], originRef: displayRef(x.seed) } : {}),
        ...(path === undefined ? {} : { path }), ...(typeof qn === "string" ? { qualifiedName: qn } : {}),
      };
    }),
  };
}

export interface PlanInput {
  readonly truth: ProjectTruth;
  readonly task: string;
  readonly seeds: SeedResult;
  readonly expansion: Expansion;
  readonly reader: SourceReader;
}

export function planContext(input: PlanInput): ContextPlan {
  const { truth, reader, expansion } = input;
  const diagnostics: Diagnostic[] = [];
  const req = new Map(truth.requirements.map((r) => [r.id, r] as const));
  const dec = new Map(truth.decisions.map((d) => [d.id, d] as const));
  const con = new Map(truth.constraints.map((c) => [c.id, c] as const));
  const iss = new Map(truth.issues.map((i) => [i.id, i] as const));
  const mil = new Map(truth.milestones.map((m) => [m.id, m] as const));
  const seedIds = new Set(input.seeds.seeds.map((s) => s.id));
  /** Exact seeds (ID, path, symbol) are mandatory; keyword seeds are ordinary candidates. */
  const exactSeeds = new Set(input.seeds.seeds.filter((s) => s.match !== "keyword").map((s) => s.id));

  const slice = (loc: SourceLocation): string | undefined => {
    const r = reader.slice(loc);
    diagnostics.push(...r.diagnostics);
    return r.value;
  };

  const drafts = new Map<string, Draft>();
  const pendingDrafts = new Map<string, Omit<PlannedPending, "requiresHumanDecision" | "relatesTo" | "levels"> & { near: boolean; seed: boolean; build: (requires: boolean) => LevelText[] }>();
  const history = new Map<string, DecisionHistoryItem>();
  const truthDepth = new Map<string, number>();
  const put = (d: Draft) => {
    const prev = drafts.get(d.id);
    if (prev === undefined || d.score > prev.score || (d.score === prev.score && d.depth < prev.depth)) drafts.set(d.id, d);
  };
  const via = (c: Candidate, extra: readonly EvidenceStep[] = []) => ({ seed: displayRef(c.seed), steps: [...c.steps, ...extra] });

  const requirementItem = (r: Requirement, c: Candidate) => {
    const head = `${r.id} ${r.title} (${[r.status, r.milestone, r.priority].filter((x) => x !== null && x !== undefined).join(", ")})`;
    const body = firstParagraph(r.description);
    const exact = slice(r.location);
    put({
      id: c.node.id, ref: r.id, kind: "requirement", tier: "requirement", score: c.score, depth: c.depth, mandatory: exactSeeds.has(c.node.id),
      levels: levels([["L1", head], ["L2", body === "" ? undefined : `${head}\n${body}`], ["L3", exact === undefined ? undefined : `${head}\n${fence(exact, "md")}`]]),
      via: via(c), source: r.location, file: r.location.path,
    });
  };
  const activeDecisionItem = (d: Decision, c: Candidate, extra: readonly EvidenceStep[] = []) => {
    const head = `${d.id} ${d.title} = ${d.answer} [${[d.state, d.enforcement].filter((x) => x !== undefined).join(", ")}]`;
    const l2 = [head, `question: ${d.question}`, ...(d.rationale === undefined ? [] : [`rationale: ${d.rationale}`])].join("\n");
    const exact = slice(d.location);
    put({
      id: `dec:${d.id}`, ref: d.id, kind: "decision", tier: "decision", score: c.score, depth: c.depth + extra.length, mandatory: true,
      levels: levels([["L1", head], ["L2", l2], ["L3", exact === undefined ? undefined : `${head}\n${fence(exact, langOf(d.location.path))}`]]),
      via: via(c, extra), source: d.location, state: d.state, file: d.location.path,
    });
  };
  const constraintItem = (k: Constraint, c: Candidate, extra: readonly EvidenceStep[] = []) => {
    const head = `${k.id} ${k.statement} [${k.state}, ${k.enforcement}]`;
    // A YAML list entry starts after "- ": take its line from column 1 so the indentation reads right.
    const exact = slice(k.location.startLine === undefined ? k.location : { ...k.location, startColumn: 1 });
    put({
      id: `dec:${k.id}`, ref: k.id, kind: "constraint", tier: "decision", score: c.score, depth: c.depth + extra.length, mandatory: true,
      levels: levels([["L1", head], ["L3", exact === undefined ? undefined : `${head}\n${fence(exact, "yaml")}`]]),
      via: via(c, extra), source: k.location, state: k.state, file: k.location.path,
    });
  };
  const pendingDecision = (id: string, kind: "decision" | "constraint", title: string, lines2: readonly string[], loc: SourceLocation, c: Candidate) => {
    pendingDrafts.set(id, {
      id, kind, title, source: loc, file: loc.path, near: c.depth <= 1, seed: seedIds.has(c.node.id),
      build: (requires) => {
        const head = `${id} ${title} — PENDING / NOT CONFIRMED${kind === "constraint" ? " (draft constraint)" : ""}${requires ? " · requires human decision" : ""}`;
        return levels([["L1", head], ["L2", [head, ...lines2].join("\n")]]);
      },
    });
  };

  const successor = (d: Decision): Decision | undefined => {
    let cur: Decision | undefined = d;
    for (let i = 0; i < 8 && cur !== undefined && cur.state === "superseded"; i++) cur = cur.supersededBy === null ? undefined : dec.get(cur.supersededBy);
    return cur !== undefined && cur.state === "confirmed" && cur.supersededBy === null ? cur : undefined;
  };

  for (const c of expansion.candidates) {
    const node = c.node;
    const ref = node.ref;
    if (ref.type === "project") continue;
    if (ref.type === "requirement" || ref.type === "decision" || ref.type === "issue" || ref.type === "milestone") {
      truthDepth.set(ref.id, Math.min(truthDepth.get(ref.id) ?? Infinity, c.depth));
    }
    switch (ref.type) {
      case "requirement": {
        const r = req.get(ref.id);
        if (r !== undefined) requirementItem(r, c);
        break;
      }
      case "decision": {
        const d = dec.get(ref.id);
        const k = con.get(ref.id);
        if (d !== undefined) {
          if (d.state === "confirmed" && d.supersededBy === null) activeDecisionItem(d, c);
          else if (d.state === "superseded") {
            history.set(d.id, { id: d.id, title: d.title, state: "superseded", supersededBy: d.supersededBy });
            const next = successor(d);
            if (next !== undefined) activeDecisionItem(next, c, [{ from: d.id, type: "SUPERSEDED_BY", to: next.id, provenance: "declared" }]);
          } else if (d.state === "proposed") {
            pendingDecision(d.id, "decision", d.title, [`question: ${d.question}`, `proposed answer: ${d.answer}`], d.location, c);
          }
        } else if (k !== undefined) {
          if (k.state === "confirmed") constraintItem(k, c);
          else if (k.state === "draft") pendingDecision(k.id, "constraint", k.statement, [], k.location, c);
        }
        break;
      }
      case "issue": {
        const i = iss.get(ref.id);
        if (i !== undefined) put(issueDraft(i, node, c, slice, via(c)));
        break;
      }
      case "milestone": {
        const m = mil.get(ref.id);
        if (m !== undefined) put(milestoneDraft(m, c, via(c)));
        break;
      }
      case "symbol": {
        const loc = node.source;
        const qn = String(node.payload.qualifiedName ?? ref.symbol);
        const head = `${qn} (${String(node.payload.kind ?? "symbol")}) ${ref.path}${lines(loc)}`;
        let l2: string | undefined, l3: string | undefined;
        if (loc !== undefined) {
          const ctx = reader.withLeadingContext(loc);
          diagnostics.push(...ctx.diagnostics);
          if (ctx.value !== undefined) {
            l3 = `${head}\n${fence(ctx.value.text, langOf(ref.path))}`;
            l2 = `${head}\n${fence(signature(ctx.value.text), langOf(ref.path))}`;
          }
        }
        put({
          id: node.id, ref: displayRef(node.id), kind: "symbol", tier: codeTier(c), score: c.score, depth: c.depth, mandatory: exactSeeds.has(node.id),
          levels: levels([["L1", head], ["L2", l2], ["L3", l3]]), via: via(c), ...(loc === undefined ? {} : { source: loc }), file: ref.path,
        });
        break;
      }
      case "test": {
        const loc = node.source;
        const head = `${String(node.payload.fullName ?? ref.name)} ${ref.path}${lines(loc)}`;
        let l3: string | undefined;
        if (loc !== undefined) {
          const ctx = reader.withLeadingContext(loc);
          diagnostics.push(...ctx.diagnostics);
          if (ctx.value !== undefined) l3 = `${head}\n${fence(ctx.value.text, langOf(ref.path))}`;
        }
        put({
          id: node.id, ref: displayRef(node.id), kind: "test", tier: "test", score: c.score, depth: c.depth, mandatory: exactSeeds.has(node.id),
          levels: levels([["L1", head], ["L3", l3]]), via: via(c), ...(loc === undefined ? {} : { source: loc }), file: ref.path,
        });
        break;
      }
      case "file": {
        const language = typeof node.payload.language === "string" ? ` (${node.payload.language})` : "";
        put({
          id: node.id, ref: ref.path, kind: "file", tier: codeTier(c), score: c.score, depth: c.depth, mandatory: exactSeeds.has(node.id),
          levels: levels([["L1", `${ref.path}${language}`]]), via: via(c), file: ref.path,
        });
        break;
      }
    }
  }

  // Constraints have no graph edges: the shared relevance policy matches them against the ranked candidates (T10.1).
  const byId = new Map(expansion.candidates.map((x) => [x.node.id, x] as const));
  const scope = candidateScope(expansion, input.seeds.seeds, input.task);
  for (const k of truth.constraints) {
    if (drafts.has(`dec:${k.id}`) || pendingDrafts.has(k.id) || (k.state !== "confirmed" && k.state !== "draft")) continue;
    const r = matchConstraint(k, scope);
    const hit = r.matched === undefined ? undefined : byId.get(r.matched);
    if (r.relevance === "none" || hit === undefined || r.field === undefined) continue;
    const step: EvidenceStep = { from: r.field === "match.keywords" ? "task" : displayRef(hit.node.id), type: "MATCHES", to: k.id, provenance: r.field };
    if (k.state === "confirmed") constraintItem(k, hit, [step]);
    else pendingDecision(k.id, "constraint", k.statement, [], k.location, hit);
  }

  // Pending proposals: only those that refer to a seed or a Truth item next to it (T09.1 read model).
  const truthSeeds = input.seeds.seeds.filter((s) => /^(req|dec|issue|ms):/u.test(s.id));
  const firstHop = [...truthDepth].filter(([, d]) => d <= 1).map(([id]) => id);
  const nearIds = new Set([...firstHop, ...truthSeeds.map((s) => s.ref)]);
  const seedTruth = new Set([...truthSeeds.filter((s) => s.match !== "keyword").map((s) => s.ref), ...firstHop]);
  const activeIds = new Set([...drafts.values()].filter((d) => d.kind === "decision").map((d) => d.ref));
  const allTruth = new Set([...truthDepth.keys(), ...activeIds]);
  const pending: PlannedPending[] = [];
  for (const p of pendingDecisionProposals(truth)) {
    const refs = proposalRefs(p);
    const mentioned = input.seeds.proposalIds.includes(p.id);
    if (!mentioned && !refs.some((r) => nearIds.has(r) || activeIds.has(r))) continue;
    const relatesTo = refs.filter((r) => allTruth.has(r)).sort(compareUtf8);
    const requires = mentioned || refs.some((r) => seedTruth.has(r)) || (p.supersedes !== null && activeIds.has(p.supersedes));
    const head = `${p.id} ${p.title} — PENDING / NOT CONFIRMED${requires ? " · requires human decision" : ""}`;
    const l2 = [head, `question: ${p.question}`, `proposed answer: ${p.answer}`, ...(p.rationale === undefined ? [] : [`rationale: ${p.rationale}`]),
      ...(relatesTo.length === 0 ? [] : [`relates to: ${relatesTo.join(", ")}`])].join("\n");
    pending.push({ id: p.id, kind: "proposal", title: p.title, requiresHumanDecision: requires, relatesTo, levels: levels([["L1", head], ["L2", l2]]), source: p.location, file: p.location.path });
  }
  for (const d of pendingDrafts.values()) {
    const requires = d.seed || d.near;
    pending.push({ id: d.id, kind: d.kind, title: d.title, requiresHumanDecision: requires, relatesTo: [], levels: d.build(requires), ...(d.source === undefined ? {} : { source: d.source }), file: d.file });
  }
  pending.sort((a, b) => compareUtf8(a.id, b.id));

  dedupeContainers(drafts, exactSeeds);
  const ordered = [...drafts.values()].sort((a, b) =>
    (TIER_INDEX.get(a.tier) ?? 0) - (TIER_INDEX.get(b.tier) ?? 0) || b.score - a.score || a.depth - b.depth || compareUtf8(a.id, b.id));
  const items: PlannedItem[] = ordered.map((d, i) => ({
    id: d.id, ref: d.ref, kind: d.kind, tier: d.tier, rank: i + 1, mandatory: d.mandatory, levels: d.levels, via: d.via,
    ...(d.source === undefined ? {} : { source: d.source }), ...(d.state === undefined ? {} : { state: d.state }), file: d.file,
  }));

  const signals: KnowledgeSignal[] = [];
  if (input.seeds.unresolvedIds.length > 0) signals.push({ kind: "unresolved-id", ids: input.seeds.unresolvedIds });
  if (!items.some((i) => i.tier === "requirement" || i.tier === "decision")) signals.push({ kind: "no-confirmed-intent" });
  const unconfirmed = pending.filter((p) => p.requiresHumanDecision).map((p) => p.id);
  if (unconfirmed.length > 0) signals.push({ kind: "unconfirmed-decision", ids: unconfirmed });

  return {
    items, pending, history: [...history.values()].sort((a, b) => compareUtf8(a.id, b.id)), signals,
    traversalTruncated: expansion.truncated, keywordOnly: input.seeds.seeds.every((s) => s.match === "keyword"),
    diagnostics,
  };
}

function proposalRefs(p: Proposal): string[] {
  const out = new Set<string>(p.governs.requirements);
  if (p.supersedes !== null) out.add(p.supersedes);
  for (const r of p.references) out.add(r.target);
  for (const e of p.evidence) if (e.id !== undefined) out.add(e.id);
  return [...out].sort(compareUtf8);
}

function issueDraft(i: Issue, node: GraphNode, c: Candidate, slice: (l: SourceLocation) => string | undefined, v: PacketItem["via"]): Draft {
  const head = `${i.id} ${i.title} (${[i.status, i.milestone].filter((x) => x !== null).join(", ")})`;
  const ac = i.acceptance.map((a) => `- ${a.id} ${a.text}`);
  const commits = Array.isArray(node.payload.commits) ? node.payload.commits.slice(0, 3).map((x) => String(x).slice(0, 12)) : [];
  const exact = slice(i.location);
  return {
    id: node.id, ref: i.id, kind: "issue", tier: "issue", score: c.score, depth: c.depth, mandatory: c.depth === 0,
    levels: levels([["L1", head], ["L2", ac.length === 0 ? undefined : [head, ...ac].join("\n")],
      ["L3", exact === undefined ? undefined : [head, fence(exact, "md"), ...(commits.length === 0 ? [] : [`commits: ${commits.join(", ")}`])].join("\n")]]),
    via: v, source: i.location, file: i.location.path,
  };
}

function milestoneDraft(m: Milestone, c: Candidate, v: PacketItem["via"]): Draft {
  return {
    id: c.node.id, ref: m.id, kind: "milestone", tier: "issue", score: c.score, depth: c.depth, mandatory: c.depth === 0,
    levels: levels([["L1", `${m.id} ${m.title} (${m.state})`]]), via: v, source: m.location, file: m.location.path,
  };
}

/**
 * Representation overlap: a class whose members are candidates keeps its signature (L2) and drops
 * its full body (L3), and a File whose symbols or tests are candidates is not listed separately
 * (unless it is an exact seed). Without this a Packet repeats the same lines.
 */
function dedupeContainers(drafts: Map<string, Draft>, exactSeeds: ReadonlySet<string>): void {
  const all = [...drafts.values()];
  for (const d of all) {
    if (d.kind === "file" && !exactSeeds.has(d.id) && all.some((o) => (o.kind === "symbol" || o.kind === "test") && o.file === d.file)) {
      drafts.delete(d.id);
      continue;
    }
    if (d.kind !== "symbol" || d.source?.startLine === undefined || d.source.endLine === undefined || d.levels[d.levels.length - 1]?.level !== "L3") continue;
    const { startLine, endLine } = d.source;
    const inner = all.some((o) => o !== d && o.kind === "symbol" && o.file === d.file && o.source?.startLine !== undefined && o.source.endLine !== undefined
      && o.source.startLine >= startLine && o.source.endLine <= endLine && (o.source.startLine > startLine || o.source.endLine < endLine));
    if (inner && d.levels.length > 1) drafts.set(d.id, { ...d, levels: d.levels.slice(0, -1) });
  }
}

/** Leading comment's first line and the declaration head (up to the line that opens the body). */
function signature(text: string): string {
  const all = text.split("\n");
  let i = 0;
  const out: string[] = [];
  while (i < all.length && /^\s*(?:\/\/|\/\*|\*|@)/u.test(all[i] ?? "")) {
    if (out.length === 0 && !/^\s*\/\*\*?\s*$/u.test(all[i] ?? "")) out.push(all[i] ?? "");
    i++;
  }
  for (let n = 0; i < all.length && n < 3; i++, n++) {
    const line = all[i] ?? "";
    out.push(line);
    if (/[{;]|=>/u.test(line)) break;
  }
  return out.join("\n");
}
