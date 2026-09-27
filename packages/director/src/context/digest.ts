/**
 * Packet Dependency Digest (05, TASK-010). sha256 over everything the Packet is derived from, and
 * nothing else:
 *
 * - request: task text as quoted (redacted, truncated), budget, profile
 * - compiler policy version, tokenizer identity (library + version), traversal limits
 * - seeds, and every ranked candidate: node ID, tier, rank, mandatory flag, the evidence path
 *   (edge types, endpoints, provenance) and the text of each of its representation levels
 *   (Requirement/Decision definition slices, symbol and test source ranges with their context)
 * - pending human decisions, superseded history, Knowledge Gap signals
 *
 * Packing and rendering are pure functions of these inputs, so two requests with the same digest
 * produce the same Packet and a cached Packet can be reused. Omitted candidates are included on
 * purpose: they appear in the Packet (omittedCandidates) and their size decided what was left out.
 * A file outside the candidate subgraph is not an input, so changing it keeps the digest. Neither
 * graph_revision nor index_state_token is used: a Requirement body change leaves both the graph
 * topology and payloads as they were but changes the digest through its definition slice.
 */
import { createHash } from "node:crypto";
import { stableJson } from "@duo-director/core";
import { TOKEN_ESTIMATOR_ID } from "../tokens/index.js";
import type { ContextPlan } from "./candidates.js";
import { CONTEXT_POLICY_VERSION } from "./policy.js";
import type { ContextProfile, ContextSeed } from "./types.js";

export const PACKET_DEPENDENCY_FORMAT = "duo.packet-deps/1";

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export interface DigestInput {
  readonly request: { readonly task: string; readonly taskTruncated: boolean; readonly budget: number; readonly profile: ContextProfile };
  readonly limits: { readonly maxDepth: number; readonly nodeLimit: number; readonly edgeLimit: number };
  readonly seeds: readonly ContextSeed[];
  readonly plan: ContextPlan;
}

export function packetDependencyDigest(input: DigestInput): string {
  const { plan } = input;
  return sha256(stableJson({
    format: PACKET_DEPENDENCY_FORMAT,
    policy: CONTEXT_POLICY_VERSION,
    tokenizer: TOKEN_ESTIMATOR_ID,
    request: { task: sha256(input.request.task), taskTruncated: input.request.taskTruncated, budget: input.request.budget, profile: input.request.profile },
    limits: input.limits,
    seeds: input.seeds,
    items: plan.items.map((i) => ({
      id: i.id, ref: i.ref, kind: i.kind, tier: i.tier, rank: i.rank, mandatory: i.mandatory, file: i.file, state: i.state ?? null, source: i.source ?? null,
      via: i.via, levels: i.levels.map((l) => [l.level, sha256(l.text), l.redactions]),
    })),
    pending: plan.pending.map((p) => ({
      id: p.id, kind: p.kind, title: p.title, requires: p.requiresHumanDecision, relatesTo: p.relatesTo, source: p.source ?? null,
      levels: p.levels.map((l) => [l.level, sha256(l.text), l.redactions]),
    })),
    history: plan.history,
    signals: plan.signals,
    traversalTruncated: plan.traversalTruncated,
    keywordOnly: plan.keywordOnly,
  }));
}
