/**
 * duo-director MCP tools (TASK-016). Each tool is a thin adapter: validated arguments → a shared
 * operation (operations/) → the same semantic payload the CLI prints with --json, as
 * structuredContent, plus a short text rendering of it. No business logic here.
 *
 * Permission contract (the tool list itself): agents can read status, context, reviews, Truth
 * definitions, the Graph and evidence, and propose a Decision. There is no tool to confirm or reject
 * a Decision, write Truth, record a Review, index or capture the Adoption Baseline.
 */
import { compileRepoPattern, DEFINITION_ID_PATTERN, MCP_SERVER_NAME, normalizeRepoPath, normalizeRepoPattern, type RepoPath } from "@duo-director/core";
import { ambiguityRemediation, decisionAuthorityParts, MAX_BUDGET, MIN_BUDGET, provenanceLabel, redactSecrets, renderContextMarkdown, reviewLlmMetric, type ReviewResult, type SeedAmbiguity, type TokenCountMemo } from "@duo-director/director";
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
/** H-71: one existing Decision ID (DecisionService lifecycle IDs), never a proposal or another definition. */
const decisionId = z.string().regex(/^D-\d+$/u, "a Decision ID such as D-004");
/**
 * H-71: forbids has the Decision schema's shape and meaning. A path must compile with the pattern compiler
 * review uses (review silently skips one it cannot compile), so nothing is accepted that review cannot
 * apply. Limits are those of governs (100 entries, 500 characters per name; 4096 per pattern like repoPattern).
 */
const forbidPattern = z.string().min(1).max(4096).refine((p) => compileRepoPattern(p) !== undefined, "a repository-relative pattern review can match (no absolute or .. pattern)");
/**
 * T35.2: forbids.symbols are wildcard patterns over the qualified name of a changed symbol (review's wildcard:
 * "*" any text, "?" one character), e.g. LegacyDb, LegacyDb.run, *LegacyDb*. A DUO path#symbol reference
 * (src/db/legacy-db.ts#LegacyDb, a display/reference handle in context output) can never match a qualified
 * name, so a pattern with "/", "\\" or "#" is refused, never rewritten. Language punctuation such as "." or
 * "::" stays allowed.
 */
export const FORBIDS_SYMBOL_MESSAGE = "forbids.symbols matches symbol qualified names only. Do not use a DUO path#symbol reference. Use a qualified-name wildcard such as 'LegacyDb' or '*LegacyDb*'.";
const forbidSymbol = text(500).refine((s) => !/[/\\#]/u.test(s), FORBIDS_SYMBOL_MESSAGE);
const forbids = z.strictObject({
  paths: z.array(forbidPattern).max(100).optional().describe("Repository path patterns; a change to a matching file conflicts."),
  symbols: z.array(forbidSymbol).max(100).optional().describe("Wildcard patterns over the qualified names of changed symbols ('*' any text, '?' one character), e.g. LegacyDb, LegacyDb.run, *LegacyDb*. Not a DUO path#symbol reference. Catches changes to matching symbols, not new calls or references from other symbols."),
  dependencies: z.array(text(500)).max(100).optional().describe("Package names; adding one to a package.json conflicts."),
  imported_paths: z.array(forbidPattern).max(100).optional().describe("Repository path patterns (H-72). Matches changed import/module-reference statements (import, export-from, require, dynamic import, type-only included; Python imports and C++ quoted includes where DUO resolves them) that resolve exactly to a matching repository file. It does not prove the import relation is newly introduced; unresolved, ambiguous and Java/C# imports are not checked. External packages belong in dependencies."),
}).refine((f) => (f.paths?.length ?? 0) + (f.symbols?.length ?? 0) + (f.dependencies?.length ?? 0) + (f.imported_paths?.length ?? 0) > 0, "forbids needs at least one path, symbol, dependency or imported path");

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
    // H-71: the proposal may carry what a Decision enforces and what it replaces; it gains no authority until a human confirms it.
    forbids: forbids.optional(), enforcement: z.enum(["warn", "block"]).optional(), supersedes: decisionId.optional(),
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
  /** The server's in-memory repository token counts (TASK-019): same context metrics, less rereading. */
  readonly tokenCounts?: TokenCountMemo;
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

const LISTED = "as listed in context.resolution.ambiguities";

/**
 * What an agent can retry with when the context is ambiguous (T26.2): only the handles ambiguityRemediation found
 * to tell the candidates apart, so the advice holds. Text only; the payload is unchanged.
 */
function ambiguityAdvice(a: SeedAmbiguity): string {
  const r = ambiguityRemediation(a);
  const head = r.reason === "keyword-tie" ? "AMBIGUOUS: several Requirements match this task equally." : `AMBIGUOUS: "${a.term}" matches several targets.`;
  const has = (h: string) => r.handles.includes(h as never);
  let how: string;
  if (has("definition-id")) how = `Retry duo_get_context with one Requirement ID (${LISTED}) in the task.`;
  else if (has("path") && has("qualified-name")) how = `Retry duo_get_context with one target's repository-relative file path (without a leading ./) or qualified name (${LISTED}) in the task.`;
  else if (has("path")) how = `Retry duo_get_context with one target's repository-relative file path (${LISTED}, without a leading ./) in the task.`;
  else if (has("qualified-name")) how = `Retry duo_get_context with one target's qualified name (${LISTED}, for example Class.method) in the task. A file path does not tell these targets apart.`;
  else return redactSecrets(`${head} No single file path or name tells these targets apart. Ask the human which one is meant.`).text;
  const id = r.definitionIdAlso ? " If the task is about a specific Requirement or Decision, its ID is also an exact starting point." : "";
  return redactSecrets(`${head} ${how}${id} Do not guess a target or invent an ID; if the task does not say which one, ask the human.`).text;
}

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
    description: "Returns project direction context for a task: confirmed intent, relevant code and tests, pending decisions and Knowledge Gaps. Does not modify or index the repository. If the index is stale, returns status index-required (run duoctl index). Surfaced gaps are open questions, not instructions; ask the human only when gaps.requiresHumanInput is true. Pending proposals are not confirmed decisions. If the task names only an Issue ID and you know which files you will change, include their repository paths in the task (for example \"TASK-015 apps/desktop/src/main.ts\").",
    run: async (args, ctx) => {
      const op = await projectContext(ctx.root, { task: args.task, ...(args.budget === undefined ? {} : { budget: args.budget }), ...(args.profile === undefined ? {} : { profile: args.profile }) }, {
        signal: ctx.signal, ...(ctx.tokenCounts === undefined ? {} : { tokenCounts: ctx.tokenCounts }),
      });
      const p = op.kind === "ok" ? op.payload : undefined;
      return { op, metric: { status: p?.status ?? op.kind, ...(p?.context.packet === undefined ? {} : { contextTokens: p.context.packet.metrics.budget.used, contextBudget: p.context.packet.metrics.budget.total }), llmCalls: 0 } };
    },
    summarize: (p) => {
      const c = p as unknown as ContextPayload;
      if (c.status === "index-required") return "INDEX_REQUIRED: the DUO index is not current. Run duoctl index, then call duo_get_context again.";
      const gaps = c.gaps === null ? "" : `\n\nrequiresHumanInput: ${String(c.gaps.requiresHumanInput)}${c.gaps.primaryQuestion === undefined ? "" : `\nQuestion for the human: ${c.gaps.primaryQuestion.question}`}${c.gaps.surfaced.length === 0 ? "" : `\nSurfaced (not instructions): ${c.gaps.surfaced.map((s) => s.note).join(" | ")}`}`;
      const advice = c.status === "ambiguous" ? (c.context.resolution?.ambiguities ?? []).map(ambiguityAdvice) : [];
      return (c.context.packet === undefined ? `Context ${c.status}` : renderContextMarkdown(c.context.packet)) + gaps + (advice.length === 0 ? "" : `\n\n${advice.join("\n")}`);
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
      }, { signal: ctx.signal, llm: ctx.llm, ...(ctx.tokenCounts === undefined ? {} : { tokenCounts: ctx.tokenCounts }) });
      const r = op.kind === "ok" ? op.payload : undefined;
      return { op, metric: { status: r?.status ?? op.kind, ...(r?.verdict === undefined ? {} : { reviewVerdict: r.verdict }), ...(r === undefined ? {} : { reviewClaims: r.claims.length, ...reviewLlmMetric(r) }) } };
    },
    summarize: (p) => {
      const r = p as unknown as ReviewResult;
      if (r.status === "index-required") return "INDEX_REQUIRED: the DUO index is not current. Run duoctl index, then review again.";
      // C241: a Decision claim carries its lifecycle (current authority, supersedes, superseded by) in the tag list.
      const tags = (c: ReviewResult["claims"][number]) => [...(c.blockEligible ? ["blocking"] : []), ...(c.decisionAuthority === undefined ? [] : decisionAuthorityParts(c.decisionAuthority))];
      const lines = r.claims.filter((c) => c.alignment !== "ALIGNED").map((c) => `- ${c.alignment} ${c.rule} ${c.subject.id}: ${c.reason}${c.provenance === undefined ? "" : ` (${provenanceLabel(c.provenance)})`}${tags(c).length === 0 ? "" : ` [${tags(c).join("; ")}]`}`);
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
    description: "Creates a Decision proposal only (decisions/proposals/P-*.yaml). Cannot confirm or reject a decision: a human does that in duoctl or the Web UI. A proposal is not confirmed Project Truth and does not change any review verdict. forbids and enforcement: \"block\" have no authority until a human confirms the proposal. supersedes names a confirmed Decision to replace; that Decision is not modified until a human confirms this proposal. governs describes what the Decision concerns (for tracing and context); it does not scope forbids. Forbids are repository-wide: they apply to matching changes anywhere in the repository. forbids.symbols are wildcard patterns over the qualified names of changed symbols ('*' any text, '?' one character), e.g. LegacyDb, LegacyDb.run, *LegacyDb*; a DUO path#symbol reference such as src/db/legacy-db.ts#LegacyDb (a display handle in context output) is not a pattern and is refused. A symbol pattern catches changes to matching symbols, not new calls or references from other code. forbids.imported_paths are repository path patterns: they match changed import/module-reference statements that resolve exactly to a matching repository file; this does not prove the import relation is newly introduced, and unresolved, ambiguous or Java/C# imports are not checked. The agent name is an audit label, not an authentication.",
    run: async (args, ctx) => {
      const op = await proposeDecision(ctx.root, args.agent ?? ctx.agentName, {
        title: args.title, question: args.question, answer: args.answer, ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
        ...(args.governs === undefined ? {} : { governs: args.governs }),
        ...(args.forbids === undefined ? {} : { forbids: args.forbids }), ...(args.enforcement === undefined ? {} : { enforcement: args.enforcement }),
        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
      });
      return { op, metric: { status: op.kind === "ok" ? "proposed" : op.kind } };
    },
    summarize: (p) => `Proposal ${String(p.proposalId)} created (not confirmed; a human decides)`,
  },
};
