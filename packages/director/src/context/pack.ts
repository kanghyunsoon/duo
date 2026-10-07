/**
 * Budget allocation (05 §5, TASK-010). Candidates are ranked first, then placed:
 *
 * 1. Frame: header, task, section headings, pending human decisions at L1, limitations (reserved).
 * 2. Mandatory items at L1: seeds, active Decisions and confirmed Constraints (05 §3).
 * 2a. Explicit primary seeds (H-76: a Requirement or Issue the task names by exact ID) are raised one level at a
 *    time to their highest fitting representation before any other promotion. If the full representation does not
 *    fit, the packet says so (explicit-seed-truncated) instead of dropping it silently.
 * 3. Capped pass: per tier in priority order (intent > decision > pending > direct code > tests >
 *    issues > structural > historical), raise items one level at a time (L0→L1, then L2, then L3)
 *    within the tier's share of the promotion budget and at most two L3 items per file.
 * 4. Uncapped pass: the same order with whatever is left.
 * 5. Exact check: the rendered Markdown is measured with o200k_base; while it is over budget the
 *    latest promotion is undone, so normal promotions go before an explicit seed's. The budget is never exceeded.
 *
 * Nothing is cut from the front: an item enters at a representation level or not at all, and
 * every candidate left out is listed in omittedCandidates.
 */
import { createDiagnostic, failure, success, type ParseResult } from "@duo-director/core";
import { TOKEN_ESTIMATOR } from "../tokens/index.js";
import { codePoints } from "../tokens/index.js";
import type { ContextPlan, PlannedItem, PlannedPending } from "./candidates.js";
import type { TokenMeter } from "./meter.js";
import { L3_PER_FILE_FIRST_PASS, TIER_ORDER, TIER_SHARE } from "./policy.js";
import { renderContextMarkdown, renderEvidenceLine, renderItemBlock } from "./render.js";
import type { ContextLimitation, ContextPacket, ContextProfile, ContextSeed, ContextTier, PacketItem, PendingDecisionItem } from "./types.js";

export interface PackInput {
  readonly plan: ContextPlan;
  readonly request: { readonly task: string; readonly taskTruncated: boolean; readonly budget: number; readonly profile: ContextProfile };
  readonly seeds: readonly ContextSeed[];
  readonly dependencyDigest: string;
  readonly meter: TokenMeter;
}

interface Slot<T> {
  readonly value: T;
  /** Index into value.levels; -1 = not in the Packet. */
  level: number;
}

const STATIC_LIMITATIONS: readonly ContextLimitation[] = [
  { code: "calls-exact-only", message: "CALLS edges exist only for exactly resolved calls; instance, dynamic and injected calls are not in the graph." },
  { code: "files-by-path", message: "Files are listed by path; whole files are never included. Symbols and tests show their own source range; a file without a structural analyzer shows at most its first lines." },
  { code: "no-diff", message: "The working-tree diff is not part of this packet." },
];

/** An explicit primary seed below its full representation: ref, tokens of the full representation, shown level (-1: not shown). */
interface TruncatedSeed {
  readonly ref: string;
  readonly fullTokens: number;
  readonly shown: string | undefined;
}

function limitations(plan: ContextPlan, taskTruncated: boolean, omitted: number, summarized: number, budget: number, truncatedSeeds: readonly TruncatedSeed[]): ContextLimitation[] {
  const out = [...STATIC_LIMITATIONS];
  for (const t of truncatedSeeds) {
    out.push({
      code: "explicit-seed-truncated",
      message: t.shown === undefined
        ? `Explicit seed ${t.ref} could not fit within the ${budget}-token budget (its full specification is ${t.fullTokens} tokens); it is not shown.`
        : `Explicit seed ${t.ref} could not fit its full specification within the ${budget}-token budget (${t.fullTokens} tokens); the highest fitting representation (${t.shown}) is shown.`,
    });
  }
  if (omitted > 0) out.push({ code: "omitted", message: `omitted: ${omitted} lower-ranked candidates did not fit the budget (ids in omittedCandidates).` });
  if (summarized > 0) out.push({ code: "summarized", message: `summarized: ${summarized} items are shown below their full representation.` });
  if (plan.traversalTruncated) out.push({ code: "traversal-truncated", message: "traversal: the candidate search hit its node or edge limit; more related nodes may exist." });
  if (plan.keywordOnly) out.push({ code: "keyword-seeds", message: "seeds: found by keyword matching only; name the target ID for a precise packet." });
  if (plan.signals.some((s) => s.kind === "no-confirmed-intent")) out.push({ code: "no-confirmed-intent", message: "intent: no confirmed Requirement or Decision relates to this task." });
  if (taskTruncated) out.push({ code: "task-truncated", message: "task: the task text was cut to 200 tokens." });
  out.push(...plan.analysisLimits);
  return out;
}

export function packContext(input: PackInput): ParseResult<ContextPacket> {
  const { plan, request, meter } = input;
  const items: Slot<PlannedItem>[] = plan.items.map((value) => ({ value, level: -1 }));
  const pending: Slot<PlannedPending>[] = plan.pending.map((value) => ({ value, level: 0 }));

  const block = (text: string) => meter.count(renderItemBlock(text) + "\n");
  const evidence = (i: PlannedItem) => meter.count(renderEvidenceLine(i.ref, i.via) + "\n");
  const itemTokens = (i: PlannedItem, level: number) => (level < 0 ? 0 : block(i.levels[level]?.text ?? "") + evidence(i));
  const truncatedSeed = (s: Slot<PlannedItem>, level: number): TruncatedSeed => ({
    ref: s.value.ref, fullTokens: itemTokens(s.value, s.value.levels.length - 1), shown: level < 0 ? undefined : (s.value.levels[level]?.level ?? "L1"),
  });
  const pendingTokens = (p: PlannedPending, level: number) => block(p.levels[level]?.text ?? "");

  const build = (): { packet: ContextPacket; markdown: string } => {
    const chosen = items.filter((s) => s.level >= 0);
    const toItem = (s: Slot<PlannedItem>): PacketItem => {
      const i = s.value;
      const lv = i.levels[s.level];
      return {
        id: i.id, ref: i.ref, kind: i.kind, rank: i.rank, tier: i.tier, level: lv?.level ?? "L1", text: lv?.text ?? "", tokens: itemTokens(i, s.level),
        ...(i.source === undefined ? {} : { source: i.source }), via: i.via, ...(i.state === undefined ? {} : { state: i.state }),
      };
    };
    const of = (pred: (i: PlannedItem) => boolean) => chosen.filter((s) => pred(s.value)).map(toItem);
    const pend: PendingDecisionItem[] = pending.map((s) => ({
      id: s.value.id, kind: s.value.kind, title: s.value.title, confirmed: false, status: "PENDING / NOT CONFIRMED", requiresHumanDecision: s.value.requiresHumanDecision,
      relatesTo: s.value.relatesTo, level: s.value.levels[s.level]?.level === "L2" ? "L2" : "L1", text: s.value.levels[s.level]?.text ?? "",
      tokens: pendingTokens(s.value, s.level), ...(s.value.source === undefined ? {} : { source: s.value.source }),
    }));
    const omitted = items.filter((s) => s.level < 0);
    const summarized = chosen.filter((s) => s.level < s.value.levels.length - 1).length;
    const taskTruncated = request.taskTruncated;
    const truncatedSeeds = items.filter((s) => s.value.primary === true && s.level < s.value.levels.length - 1).map((s) => truncatedSeed(s, s.level));
    const packet: ContextPacket = {
      format: "duo.context-packet/1",
      request,
      seeds: input.seeds,
      intent: { requirements: of((i) => i.kind === "requirement"), constraints: of((i) => i.kind === "constraint") },
      decisions: { active: of((i) => i.kind === "decision"), history: plan.history },
      code: of((i) => i.kind === "symbol" || i.kind === "file"),
      tests: of((i) => i.kind === "test"),
      issues: of((i) => i.kind === "issue" || i.kind === "milestone"),
      pendingDecisions: pend,
      evidence: chosen.map((s) => ({ id: s.value.id, ref: s.value.ref, via: s.value.via })),
      limitations: limitations(plan, taskTruncated, omitted.length, summarized, request.budget, truncatedSeeds),
      signals: plan.signals,
      omittedCandidates: omitted.map((s) => ({ id: s.value.id, ref: s.value.ref, rank: s.value.rank, tier: s.value.tier, reason: "budget" as const })),
      truncated: omitted.length > 0 || plan.traversalTruncated || taskTruncated,
      requiresHumanDecision: pend.some((p) => p.requiresHumanDecision),
      metrics: placeholderMetrics(request.budget),
      dependencyDigest: input.dependencyDigest,
    };
    return { packet, markdown: renderContextMarkdown(packet) };
  };

  // Frame: every item out, worst-case limitation lines (omitted and summarized counts of full width, every explicit seed truncated).
  const frame = build();
  const frameLimits = limitations(plan, request.taskTruncated, Math.max(1, items.length), Math.max(1, items.length), request.budget,
    items.filter((s) => s.value.primary === true).map((s) => truncatedSeed(s, 0)));
  const reserved = meter.count(renderContextMarkdown({ ...frame.packet, limitations: frameLimits }));
  if (reserved > request.budget) {
    return failure([createDiagnostic("CONTEXT_REQUEST_INVALID", `budget ${request.budget} is smaller than the packet frame (${reserved} tokens: task, headings, pending decisions, limitations)`)]);
  }
  const available = request.budget - reserved;
  let spent = 0;
  const log: { slot: Slot<PlannedItem> | Slot<PlannedPending>; from: number }[] = [];
  const cost = (slot: Slot<PlannedItem> | Slot<PlannedPending>, to: number): number => {
    if ("rank" in slot.value) {
      const v = slot.value as PlannedItem;
      return itemTokens(v, to) - itemTokens(v, slot.level);
    }
    const v = slot.value as PlannedPending;
    return pendingTokens(v, to) - pendingTokens(v, slot.level);
  };
  const tierSpent = new Map<ContextTier, number>();
  const raise = (slot: Slot<PlannedItem> | Slot<PlannedPending>, tier: ContextTier, cap: number | undefined): boolean => {
    const to = slot.level + 1;
    if (to >= slot.value.levels.length) return false;
    const delta = cost(slot, to);
    if (spent + delta > available) return false;
    if (cap !== undefined && (tierSpent.get(tier) ?? 0) + delta > cap) return false;
    log.push({ slot, from: slot.level });
    slot.level = to;
    spent += delta;
    tierSpent.set(tier, (tierSpent.get(tier) ?? 0) + delta);
    return true;
  };

  for (const s of items) if (s.value.mandatory) raise(s, s.value.tier, undefined);
  // H-76: explicit primary seeds next, one level at a time to the highest that fits, in plan order (tier, order value, depth, ID).
  for (const s of items) {
    if (s.value.primary !== true) continue;
    while (raise(s, s.value.tier, undefined)) { /* raised one level */ }
  }
  const promotion = available - spent;
  const byTier = (tier: ContextTier): (Slot<PlannedItem> | Slot<PlannedPending>)[] => (tier === "pending" ? pending : items.filter((s) => s.value.tier === tier));
  for (const capped of [true, false]) {
    if (capped) tierSpent.clear();
    for (const tier of TIER_ORDER) {
      const slots = byTier(tier);
      const cap = capped ? TIER_SHARE[tier] * promotion : undefined;
      const l3PerFile = new Map<string, number>();
      for (let round = 0; round <= 2; round++) {
        for (const slot of slots) {
          if (slot.level !== round - 1) continue;
          const next = slot.value.levels[round];
          if (next === undefined) continue;
          if (capped && next.level === "L3") {
            const n = l3PerFile.get(slot.value.file) ?? 0;
            if (n >= L3_PER_FILE_FIRST_PASS) continue;
            if (raise(slot, tier, cap)) l3PerFile.set(slot.value.file, n + 1);
          } else raise(slot, tier, cap);
        }
      }
    }
  }

  let result = build();
  let used = meter.count(result.markdown);
  while (used > request.budget && log.length > 0) {
    const last = log.pop();
    if (last !== undefined) last.slot.level = last.from;
    result = build();
    used = meter.count(result.markdown);
  }
  if (used > request.budget) {
    return failure([createDiagnostic("CONTEXT_REQUEST_INVALID", `budget ${request.budget} cannot hold the packet frame (${used} tokens)`)]);
  }

  const candidateTokens = items.reduce((n, s) => n + itemTokens(s.value, s.value.levels.length - 1), 0)
    + pending.reduce((n, s) => n + pendingTokens(s.value, s.value.levels.length - 1), 0);
  const selectedCount = items.filter((s) => s.level >= 0).length;
  const redactions = items.reduce((n, s) => n + (s.level >= 0 ? (s.value.levels[s.level]?.redactions ?? 0) : 0), 0)
    + pending.reduce((n, s) => n + (s.value.levels[s.level]?.redactions ?? 0), 0);
  const packet: ContextPacket = {
    ...result.packet,
    metrics: {
      estimator: TOKEN_ESTIMATOR.name,
      budget: { total: request.budget, reserved, used, remaining: request.budget - used },
      candidates: items.length,
      selected: selectedCount,
      omitted: items.length - selectedCount,
      candidateTokens,
      selectedTokens: used,
      rendered: { tokens: used, estimator: TOKEN_ESTIMATOR.name, bytes: Buffer.byteLength(result.markdown, "utf8"), chars: codePoints(result.markdown) },
      redactions,
      llmCalls: 0,
    },
  };
  return success(packet);
}

function placeholderMetrics(budget: number): ContextPacket["metrics"] {
  return {
    estimator: TOKEN_ESTIMATOR.name, budget: { total: budget, reserved: 0, used: 0, remaining: budget }, candidates: 0, selected: 0, omitted: 0,
    candidateTokens: 0, selectedTokens: 0, rendered: { tokens: 0, estimator: TOKEN_ESTIMATOR.name, bytes: 0, chars: 0 }, redactions: 0, llmCalls: 0,
  };
}
