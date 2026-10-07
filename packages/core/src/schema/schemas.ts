/**
 * Zod schemas for Project Truth files as written on disk (snake_case).
 * Every object is strict: unknown properties are errors. Custom data goes under "extensions".
 */
import { z } from "zod";
import { DEFINITION_ID_PATTERN, PROPOSAL_ID_PATTERN } from "../ids.js";
import { COMPATIBLE_BASE_URL_PROBLEMS, ENV_NAME_PATTERN, parseCompatibleBaseUrl } from "../llm-endpoint.js";

/** Sentinel message that validate.ts turns into an INVALID_ID diagnostic. */
export const INVALID_ID_MESSAGE = "INVALID_ID";

const id = () => z.string().regex(DEFINITION_ID_PATTERN, INVALID_ID_MESSAGE);
const ids = () => z.array(id());
const text = () => z.string().min(1);
const texts = () => z.array(text());
const extensions = z.record(z.string(), z.unknown()).optional();

/** Citation label ("D§3") or external source provenance (ADR-014). */
export const SourceRefSchema = z.union([
  text(),
  z.strictObject({ path: text(), hash: text(), section: text().optional() }),
]);
const sources = z.array(SourceRefSchema).optional();

export const EVIDENCE_KINDS = [
  "requirement", "decision", "constraint", "issue", "milestone", "file", "symbol", "test",
  "commit", "diff", "document", "review", "llm",
] as const;

/** Evidence Pointer: references only, never copied content (ADR-006). */
export const EvidencePointerSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  id: text().optional(),
  path: text().optional(),
  symbol: text().optional(),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  commit: text().optional(),
  content_hash: text().optional(),
  change: z.enum(["added", "modified", "removed"]).optional(),
});

export const ProjectConfigSchema = z.strictObject({
  schema_version: z.number().int(),
  name: text(),
  current_milestone: id().nullable().optional(),
  sources: z.strictObject({ markdown: texts().optional() }).optional(),
  index: z.strictObject({
    include: texts().optional(),
    exclude: texts().optional(),
    max_file_bytes: z.number().int().positive().optional(),
  }).optional(),
  context: z.strictObject({
    default_budget_tokens: z.number().int().positive().optional(),
    max_depth: z.number().int().min(1).max(3).optional(),
  }).optional(),
  review: z.strictObject({
    warn_on_untested_change: z.boolean().optional(),
    warn_on_unlinked_addition: z.boolean().optional(),
  }).optional(),
  test_command: text().nullable().optional(),
  llm: z.strictObject({
    provider: z.enum(["none", "openai-responses", "openai-compatible"]).optional(),
    model: text().nullable().optional(),
    api_key_env: text().optional(),
    base_url: text().nullable().optional(),
    transport: z.enum(["responses", "chat-completions"]).optional(),
    structured_output: z.enum(["json-schema", "json-object", "prompt-only"]).optional(),
    max_calls_per_review: z.number().int().min(0).optional(),
    max_input_tokens: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
    cache: z.boolean().optional(),
  }).superRefine(checkLlmConfig).optional(),
  extensions,
});

/**
 * Cross-field rules of llm (T27.1, H-60). openai-compatible needs every setting written out: model,
 * base_url (endpoint policy), transport, api_key_env (an environment variable name; no default, no
 * OPENAI_API_KEY fallback) and structured_output. transport and structured_output belong to
 * openai-compatible only; openai-responses keeps its own rules (base_url makes it unavailable at run time).
 * provider none ignores the other settings. Messages never repeat the value.
 */
function checkLlmConfig(llm: { provider?: string | undefined; model?: string | null | undefined; api_key_env?: string | undefined; base_url?: string | null | undefined; transport?: string | undefined; structured_output?: string | undefined }, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (llm.provider === "openai-compatible") {
    const required = "is required for provider openai-compatible (no default)";
    if (llm.model === undefined || llm.model === null || llm.model.trim() === "") issue("model", required);
    if (llm.transport === undefined) issue("transport", `${required}: responses or chat-completions`);
    if (llm.structured_output === undefined) issue("structured_output", `${required}: json-schema, json-object or prompt-only`);
    if (llm.api_key_env === undefined) issue("api_key_env", `${required}: the name of the environment variable that holds the key`);
    else if (!ENV_NAME_PATTERN.test(llm.api_key_env)) issue("api_key_env", "must be an environment variable name (letters, digits, _; not starting with a digit)");
    if (llm.base_url === undefined || llm.base_url === null) issue("base_url", `${required}: the endpoint's absolute URL`);
    else {
      const parsed = parseCompatibleBaseUrl(llm.base_url);
      if (parsed.problem !== undefined) issue("base_url", COMPATIBLE_BASE_URL_PROBLEMS[parsed.problem]);
    }
  } else if (llm.provider === "openai-responses") {
    for (const key of ["transport", "structured_output"] as const) if (llm[key] !== undefined) issue(key, "applies only to provider openai-compatible");
  }
}

export const VisionFrontmatterSchema = z.strictObject({
  status: z.enum(["draft", "confirmed"]),
  owner: z.literal("human").optional(),
  source: sources,
  extensions,
});

export const ConstraintSchema = z.strictObject({
  id: id(),
  statement: text(),
  state: z.enum(["draft", "confirmed", "retired"]),
  enforcement: z.enum(["warn", "block"]),
  match: z.strictObject({
    paths: texts().optional(),
    symbols: texts().optional(),
    dependencies: texts().optional(),
    keywords: texts().optional(),
  }).optional(),
  source: sources,
  lock: z.strictObject({ digest: z.string().regex(/^sha256:/) }).optional(),
  extensions,
});

export const ConstraintsFileSchema = z.strictObject({
  constraints: z.array(ConstraintSchema),
  extensions,
});

export const RequirementBlockSchema = z.strictObject({
  type: z.literal("requirement").optional(),
  status: z.enum(["planned", "in_progress", "done", "deferred"]).optional(),
  milestone: id().nullable().optional(),
  priority: z.enum(["must", "should", "could"]).optional(),
  source: sources,
  implements: z.strictObject({ paths: texts().optional(), symbols: texts().optional() }).optional(),
  tests: texts().optional(),
  depends_on: ids().optional(),
  extensions,
});

const issueShape = {
  status: z.enum(["todo", "in_progress", "review", "done"]),
  milestone: id().nullable().optional(),
  package: text().optional(),
  requirements: ids().optional(),
  decisions: ids().optional(),
  depends_on: ids().optional(),
  /** H-78 (T45): the repository path scope this Issue declares it implements (relevance / traceability only). Paths only. */
  implements: z.strictObject({ paths: texts().optional() }).optional(),
  extensions,
};

export const IssueBlockSchema = z.strictObject({ type: z.literal("issue"), ...issueShape });

/** Milestones reference issues by ID only; the issue definition owns its content and AC. */
export const MilestoneBlockSchema = z.strictObject({
  type: z.literal("milestone"),
  title: text(),
  state: z.enum(["planned", "active", "done"]),
  issues: ids().optional(),
  extensions,
});

const decisionShape = {
  title: text(),
  kind: z.enum(["decision", "constraint"]).optional(),
  question: text(),
  answer: text(),
  rationale: text().optional(),
  owner: z.literal("human").optional(),
  governs: z.strictObject({ requirements: ids().optional(), paths: texts().optional(), symbols: texts().optional() }).optional(),
  /** imported_paths (H-72): repository path patterns; a changed import resolving to a matching file conflicts. */
  forbids: z.strictObject({ dependencies: texts().optional(), symbols: texts().optional(), paths: texts().optional(), imported_paths: texts().optional() }).optional(),
  supersedes: id().nullable().optional(),
  evidence: z.array(EvidencePointerSchema).optional(),
  source: sources,
  /** How a violation is reported (ADR-007); used by Review (TASK-013). */
  enforcement: z.enum(["warn", "block"]).optional(),
  extensions,
};

/** Who asked for a Decision operation (T09). Only a human confirms or rejects. */
export const ACTOR_KINDS = ["human", "agent", "system"] as const;

/** decisions/D-###.yaml and ADR-style Markdown frontmatter. */
export const DecisionSchema = z.strictObject({
  id: id(),
  type: z.literal("decision").optional(),
  ...decisionShape,
  state: z.enum(["proposed", "confirmed", "superseded", "rejected"]),
  superseded_by: id().nullable().optional(),
  confirmed_at: text().optional(),
  confirmed_by: text().optional(),
  proposed_at: text().optional(),
  proposed_by: text().optional(),
  proposed_by_kind: z.enum(ACTOR_KINDS).optional(),
  /** The proposal this Decision was confirmed from (DecisionService). */
  proposal: z.string().regex(PROPOSAL_ID_PATTERN, INVALID_ID_MESSAGE).optional(),
  lock: z.strictObject({ digest: z.string().regex(/^sha256:/) }).optional(),
});

/** decisions/proposals/P-*.yaml. */
export const ProposalSchema = z.strictObject({
  id: z.string().regex(PROPOSAL_ID_PATTERN, INVALID_ID_MESSAGE),
  ...decisionShape,
  state: z.enum(["proposed", "rejected"]),
  proposed_by: text(),
  proposed_by_kind: z.enum(ACTOR_KINDS).optional(),
  proposed_at: text().optional(),
  /** What the proposal was based on, to detect a stale proposal at confirm time. */
  based_on: z.strictObject({
    truth_digest: z.string().regex(/^sha256:/),
    refs: z.array(z.strictObject({ id: id(), digest: z.string().regex(/^sha256:/) })).optional(),
  }).optional(),
  rejected_at: text().optional(),
  rejected_by: text().optional(),
  reason: text().optional(),
});

/**
 * milestones/*.yaml: a milestone and the IDs of its issues. Issues are defined once, in a
 * Markdown definition ("type: issue"); they are never redefined here.
 */
export const MilestoneFileSchema = z.strictObject({
  id: id(),
  title: text(),
  state: z.enum(["planned", "active", "done"]),
  issues: ids().optional(),
  extensions,
});

export type ProjectConfigData = z.output<typeof ProjectConfigSchema>;
export type VisionFrontmatterData = z.output<typeof VisionFrontmatterSchema>;
export type ConstraintData = z.output<typeof ConstraintSchema>;
export type ConstraintsFileData = z.output<typeof ConstraintsFileSchema>;
export type RequirementBlockData = z.output<typeof RequirementBlockSchema>;
export type IssueBlockData = z.output<typeof IssueBlockSchema>;
export type MilestoneBlockData = z.output<typeof MilestoneBlockSchema>;
export type DecisionData = z.output<typeof DecisionSchema>;
export type ProposalData = z.output<typeof ProposalSchema>;
export type MilestoneFileData = z.output<typeof MilestoneFileSchema>;
export type SourceRefData = z.output<typeof SourceRefSchema>;
export type EvidencePointerData = z.output<typeof EvidencePointerSchema>;
