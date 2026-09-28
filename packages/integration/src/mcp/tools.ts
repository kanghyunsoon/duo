/**
 * duo-director MCP tools (TASK-016). Each tool is a thin adapter: validated arguments → a shared
 * operation (operations/) → the same semantic payload the CLI prints with --json, as
 * structuredContent, plus a short text rendering of it. No business logic here.
 *
 * Permission contract (the tool list itself): agents can read status, context, reviews, Truth
 * definitions, the Graph and evidence, and propose a Decision. There is no tool to confirm or reject
 * a Decision, write Truth, record a Review, index or capture the Adoption Baseline.
 */
import { DEFINITION_ID_PATTERN, MCP_SERVER_NAME, normalizeRepoPath, normalizeRepoPattern, type RepoPath } from "@duo-director/core";
import { MAX_BUDGET, MIN_BUDGET, renderContextMarkdown, reviewLlmMetric, type ReviewResult } from "@duo-director/director";
import { z } from "zod";
import type { LLMProviderPool } from "../llm/factory.js";
import { NOT_INITIALIZED_FORMAT, type Operation } from "../operations/common.js";
import { CONTEXT_FORMAT, projectContext, type ContextPayload } from "../operations/context.js";
import { IMPACT_FORMAT, projectGraphQuery, TRACE_FORMAT } from "../operations/graph.js";
import { PROPOSAL_FORMAT, proposeDecision } from "../operations/propose.js";
import { diffEnd, projectReview } from "../operations/review.js";
import { EVIDENCE_SEARCH_FORMAT, searchEvidence } from "../operations/search.js";
import { projectStatus, STATUS_FORMAT } from "../operations/status.js";
import { DECISION_FORMAT, getDecision, getRequirement, REQUIREMENT_FORMAT } from "../operations/truth.js";

export { MCP_SERVER_NAME };

// ---- argument schemas: strict objects, domain validators reused ----
const repoPath = z.string().min(1).max(4096).refine((p) => normalizeRepoPath(p).value === p, "a canonical repository-relative path");
const repoPattern = z.string().min(1).max(4096).refine((p) => normalizeRepoPattern(p).value !== undefined, "a repository-relative pattern");
const definitionId = z.string().regex(DEFINITION_ID_PATTERN, "a definition ID such as AUTH-03 or D-004");
// eslint-disable-next-line no-control-regex -- control characters are refused on purpose
const endpoint = z.string().min(1).max(256).refine((v) => !v.startsWith("-") && !/[\u0000-\u001f\u007f\s]/u.test(v), "HEAD, INDEX, WORKTREE or a commit / branch name");
const text = (max: number) => z.string().trim().min(1).max(max);

export const INPUT = {
  duo_get_status: z.strictObject({}),
  duo_get_context: z.strictObject({ task: text(20_000), budget: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional(), profile: z.enum(["default", "review"]).optional() }),
  duo_review_changes: z.strictObject({
    task: text(20_000).optional(), from: endpoint.optional(), to: endpoint.optional(), files: z.array(repoPath).max(1000).optional(),
    budget: z.number().int().min(MIN_BUDGET).max(MAX_BUDGET).optional(), includeSemanticAssist: z.boolean().optional(),
  }),
  duo_get_requirement: z.strictObject({ id: definitionId }),
  duo_get_decision: z.strictObject({ id: definitionId }),
  duo_trace: z.strictObject({ node: text(4096), depth: z.number().int().min(1).max(3).optional() }),
  duo_impact: z.strictObject({ node: text(4096), depth: z.number().int().min(1).max(3).optional() }),
  duo_search_evidence: z.strictObject({ query: text(200), limit: z.number().int().min(1).max(50).optional() }),
  duo_propose_decision: z.strictObject({
    title: text(200), question: text(200), answer: text(2000), rationale: text(4000).optional(),
    governs: z.strictObject({ requirements: z.array(definitionId).max(100).optional(), paths: z.array(repoPattern).max(100).optional(), symbols: z.array(text(500)).max(100).optional() }).optional(),
    agent: text(100).optional(),
  }),
} as const;

/** Output: strict at the top level, discriminated by format; nested domain objects are the documented DUO results. */
function payloadSchema(format: string, keys: readonly string[]) {
  return z.strictObject({
    format: z.enum([format, NOT_INITIALIZED_FORMAT]),
    status: z.unknown().optional(),
    ...Object.fromEntries(keys.map((k) => [k, z.unknown().optional()])),
  });
}

export const OUTPUT = {
  duo_get_status: payloadSchema(STATUS_FORMAT, ["initialized", "project", "truth", "index", "analysis", "baseline", "pendingDecisions", "llm", "llmProvider", "message"]),
  duo_get_context: payloadSchema(CONTEXT_FORMAT, ["context", "gaps", "message"]),
  duo_review_changes: payloadSchema("duo.review/1", [
    "request", "baseline", "freshness", "diff", "seeds", "verdict", "verdictBasis", "claims", "evidence", "gaps", "context", "limitations", "semanticAssist", "metrics", "diagnostics", "message",
  ]),
  duo_get_requirement: payloadSchema(REQUIREMENT_FORMAT, ["id", "requirement", "text", "message"]),
  duo_get_decision: payloadSchema(DECISION_FORMAT, ["id", "decision", "text", "note", "message"]),
  duo_trace: payloadSchema(TRACE_FORMAT, ["index", "node", "depth", "truncated", "nodes", "edges", "message"]),
  duo_impact: payloadSchema(IMPACT_FORMAT, ["index", "node", "depth", "truncated", "seeds", "items", "evidence", "notice", "limitations", "message"]),
  duo_search_evidence: payloadSchema(EVIDENCE_SEARCH_FORMAT, ["query", "notice", "truncated", "candidates", "message"]),
  duo_propose_decision: payloadSchema(PROPOSAL_FORMAT, ["proposalId", "path", "state", "proposedBy", "confirmed", "indexRequired", "basedOn", "notice", "message"]),
} as const;

export type ToolName = keyof typeof INPUT;
type Args<N extends ToolName> = z.output<(typeof INPUT)[N]>;

export interface ToolRun {
  readonly op: Operation<unknown>;
  /** Fields for runtime/metrics.jsonl (only context, review, propose are metered). */
  readonly metric?: Record<string, unknown>;
}

export interface ToolContext {
  readonly root: string;
  readonly agentName: string;
  readonly signal: AbortSignal;
  /** The server's LLM provider pool (T12B): only duo_review_changes with includeSemanticAssist can call a provider. */
  readonly llm: LLMProviderPool;
}

export interface ToolDefinition<N extends ToolName> {
  readonly name: N;
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
  run(args: Args<N>, ctx: ToolContext): Promise<ToolRun>;
  /** Short text for the model; a rendering of the payload, never a source of decisions. */
  summarize(payload: Record<string, unknown>): string;
}

const nodeSummary = (p: Record<string, unknown>) => (p.status === "not-found" ? `Node not found: ${String(p.node)}` : `${String(p.format)} of ${JSON.stringify(p.node)} · depth ${String(p.depth)} · truncated ${String(p.truncated)} · index ${String(p.index)}`);

export const TOOLS: { readonly [N in ToolName]: ToolDefinition<N> } = {
  duo_get_status: {
    name: "duo_get_status", title: "DUO project status", readOnly: true,
    description: "Returns the DUO project status: initialized, index freshness and what a re-index would redo, adoption baseline, pending decision proposals, LLM provider state. Read-only: it never indexes or writes.",
    run: async (_args, ctx) => ({ op: await projectStatus(ctx.root, { llm: ctx.llm }) }),
    summarize: (p) => {
      const i = p.index as { status?: string } | null;
      const b = p.baseline as { status?: string } | null;
      return `DUO status: index ${i?.status ?? "unknown"} · baseline ${b?.status ?? "unknown"} · pending decisions ${(p.pendingDecisions as unknown[] | undefined)?.length ?? 0} · llm ${String(p.llm)}`;
    },
  },
  duo_get_context: {
    name: "duo_get_context", title: "Project direction context for a task", readOnly: true,
    description: "Returns project direction context for a task: confirmed intent, relevant code and tests, pending decisions and Knowledge Gaps. Does not modify or index the repository. If the index is stale, returns status index-required (run duoctl index). Surfaced gaps are open questions, not instructions; ask the human only when gaps.requiresHumanInput is true. Pending proposals are not confirmed decisions.",
    run: async (args, ctx) => {
      const op = await projectContext(ctx.root, { task: args.task, ...(args.budget === undefined ? {} : { budget: args.budget }), ...(args.profile === undefined ? {} : { profile: args.profile }) }, { signal: ctx.signal });
      const p = op.kind === "ok" ? op.payload : undefined;
      return { op, metric: { status: p?.status ?? op.kind, ...(p?.context.packet === undefined ? {} : { contextTokens: p.context.packet.metrics.budget.used, contextBudget: p.context.packet.metrics.budget.total }), llmCalls: 0 } };
    },
    summarize: (p) => {
      const c = p as unknown as ContextPayload;
      if (c.status === "index-required") return "INDEX_REQUIRED: the DUO index is not current. Run duoctl index, then call duo_get_context again.";
      const gaps = c.gaps === null ? "" : `\n\nrequiresHumanInput: ${String(c.gaps.requiresHumanInput)}${c.gaps.primaryQuestion === undefined ? "" : `\nQuestion for the human: ${c.gaps.primaryQuestion.question}`}${c.gaps.surfaced.length === 0 ? "" : `\nSurfaced (not instructions): ${c.gaps.surfaced.map((s) => s.note).join(" | ")}`}`;
      return (c.context.packet === undefined ? `Context ${c.status}` : renderContextMarkdown(c.context.packet)) + gaps;
    },
  },
  duo_review_changes: {
    name: "duo_review_changes", title: "Review changes against confirmed project direction", readOnly: true,
    description: "Reviews changes (default HEAD → WORKTREE) against confirmed project direction and returns claims, evidence, Knowledge Gaps and a verdict (PASS, WARN, BLOCK, ASK). Does not modify code or project truth, does not index (a stale index returns status index-required) and does not record the review. PASS means no direction violation found in the available evidence, not bug-free code. includeSemanticAssist (default false) asks the LLM provider configured in project.yaml for supplemental semantic checks, returned separately in semanticAssist; they never change the deterministic claims and never block.",
    run: async (args, ctx) => {
      const op = await projectReview(ctx.root, {
        diff: { from: args.from === undefined ? "HEAD" : diffEnd(args.from), to: args.to === undefined ? "WORKTREE" : diffEnd(args.to), ...(args.files === undefined ? {} : { files: args.files as RepoPath[] }) },
        ...(args.task === undefined ? {} : { task: args.task }), ...(args.budget === undefined ? {} : { budget: args.budget }),
        ...(args.includeSemanticAssist === undefined ? {} : { includeSemanticAssist: args.includeSemanticAssist }),
      }, { signal: ctx.signal, llm: ctx.llm });
      const r = op.kind === "ok" ? op.payload : undefined;
      return { op, metric: { status: r?.status ?? op.kind, ...(r?.verdict === undefined ? {} : { reviewVerdict: r.verdict }), ...(r === undefined ? {} : { reviewClaims: r.claims.length, ...reviewLlmMetric(r) }) } };
    },
    summarize: (p) => {
      const r = p as unknown as ReviewResult;
      if (r.status === "index-required") return "INDEX_REQUIRED: the DUO index is not current. Run duoctl index, then review again.";
      const lines = r.claims.filter((c) => c.alignment !== "ALIGNED").map((c) => `- ${c.alignment} ${c.rule} ${c.subject.id}: ${c.reason}${c.provenance === undefined ? "" : ` (${c.provenance})`}${c.blockEligible ? " [blocking]" : ""}`);
      const a = r.semanticAssist;
      const semantic = a.status === "not-requested" ? [] : [
        `Semantic assistance (supplemental, never blocks): ${a.status}${a.failure === undefined ? "" : ` (${a.failure})`}`,
        ...a.claims.filter((c) => c.alignment !== "ALIGNED").map((c) => `- semantic ${c.alignment} ${c.claimId}: ${c.reason}`),
      ];
      return [`Verdict ${r.verdict ?? "-"} · ${r.claims.length} claims · llm calls ${r.metrics.llmCalls}`, ...lines, ...semantic].join("\n");
    },
  },
  duo_get_requirement: {
    name: "duo_get_requirement", title: "One Requirement from Project Truth", readOnly: true,
    description: "Returns one Requirement by ID: its exact Project Truth text and metadata (status, milestone, implements, tests, sources), or status not-found. Read-only.",
    run: async (args, ctx) => ({ op: await getRequirement(ctx.root, args.id) }),
    summarize: (p) => (p.status === "found" ? String(p.text ?? p.id) : `Requirement ${String(p.id)} not found`),
  },
  duo_get_decision: {
    name: "duo_get_decision", title: "One Decision from Project Truth", readOnly: true,
    description: "Returns one Decision (or Constraint) by ID: state, whether it is active or superseded, enforcement, governs, forbids, sources and its exact text, or status not-found. Proposals are not Decisions and are not returned here. Read-only.",
    run: async (args, ctx) => ({ op: await getDecision(ctx.root, args.id) }),
    summarize: (p) => (p.status === "found" ? String(p.text ?? p.id) : `Decision ${String(p.id)} not found${p.note === undefined ? "" : `: ${String(p.note)}`}`),
  },
  duo_trace: {
    name: "duo_trace", title: "Trace a node in the Project Graph", readOnly: true,
    description: "Traces Requirement, Decision, Issue, Milestone, File, Symbol and Test links from a node (node ID, definition ID, path or unique symbol name). Bounded by depth (1-3) and a node limit; truncated says when it was cut. Read-only.",
    run: async (args, ctx) => ({ op: await projectGraphQuery(ctx.root, "trace", args.node, args.depth ?? 2) }),
    summarize: nodeSummary,
  },
  duo_impact: {
    name: "duo_impact", title: "Graph-recorded impact of a node", readOnly: true,
    description: "Returns what the DUO Graph records as affected by a node: direct, structural and historical relations with depth. This is evidence of recorded relations, not a complete list of everything a change can affect. Bounded; truncated says when it was cut. Read-only.",
    run: async (args, ctx) => ({ op: await projectGraphQuery(ctx.root, "impact", args.node, args.depth ?? 2) }),
    summarize: nodeSummary,
  },
  duo_search_evidence: {
    name: "duo_search_evidence", title: "Search DUO evidence", readOnly: true,
    description: "Deterministic search (ID, path, entity name, text) over Project Truth definitions, Graph entities, Review Records and the Adoption Baseline. Results are evidence candidates, not confirmed intent. Read-only.",
    run: async (args, ctx) => ({ op: await searchEvidence(ctx.root, args.query, args.limit ?? 20) }),
    summarize: (p) => `${(p.candidates as unknown[] | undefined)?.length ?? 0} evidence candidates for "${String(p.query)}" (not confirmed intent)`,
  },
  duo_propose_decision: {
    name: "duo_propose_decision", title: "Propose a Decision", readOnly: false,
    description: "Creates a Decision proposal only (decisions/proposals/P-*.yaml). Cannot confirm or reject a decision: a human does that in duoctl or the Web UI. A proposal is not confirmed intent. The agent name is an audit label, not an authentication.",
    run: async (args, ctx) => {
      const op = await proposeDecision(ctx.root, args.agent ?? ctx.agentName, {
        title: args.title, question: args.question, answer: args.answer, ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
        ...(args.governs === undefined ? {} : { governs: args.governs }),
      });
      return { op, metric: { status: op.kind === "ok" ? "proposed" : op.kind } };
    },
    summarize: (p) => `Proposal ${String(p.proposalId)} created (not confirmed; a human decides)`,
  },
};
