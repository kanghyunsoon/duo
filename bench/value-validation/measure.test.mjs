// Regression tests for the NOT MEASURED rule in the Value Validation 01 measurement helpers (PR #24 review).
// Runs in the main Vitest suite (vitest.config.ts includes bench/value-validation/**/*.test.mjs), so CI executes it.
import { describe, expect, it } from "vitest";
import { agentSummary, countMeasured, medianAll, parseEvents, sumAll } from "./measure.mjs";

const usage = (input, output, cached) => JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: output, ...(cached === undefined ? {} : { cached_input_tokens: cached }) } });

describe("Value Validation 01 measurement (NOT MEASURED rule)", () => {
  it("a total or median with a missing run is null, and the measured count is reported", () => {
    expect(sumAll([100, null, 100])).toBeNull();
    expect(sumAll([100, undefined])).toBeNull();
    expect(sumAll([])).toBeNull();
    expect(sumAll([100, 0, 100])).toBe(200);
    expect(medianAll([3, null, 1])).toBeNull();
    expect(medianAll([3, 1, 2])).toBe(2);
    expect(medianAll([4, 1, 3, 2])).toBe(2);
    expect(countMeasured([100, null, 100])).toBe(2);
  });

  it("an event stream without a valid usage event has usage null, not zero", () => {
    expect(parseEvents("").usage).toBeNull();
    const early = [JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } })].join("\n");
    expect(parseEvents(early).usage).toBeNull();
    expect(parseEvents(JSON.stringify({ type: "turn.completed", usage: {} })).usage).toBeNull();
    expect(parseEvents(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } })).usage).toBeNull();
    expect(parseEvents("not json\n{\"type\":").usage).toBeNull();
  });

  it("one incomplete usage event among valid ones makes the total null, not a partial sum", () => {
    expect(parseEvents([usage(10, 2, 4), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } })].join("\n")).usage).toBeNull();
    expect(parseEvents([usage(10, 2, 4), JSON.stringify({ type: "turn.completed" })].join("\n")).usage).toBeNull();
  });

  it("cached is null unless every usage event reported it; complete streams sum; a real zero is kept", () => {
    expect(parseEvents([usage(10, 2, 4), usage(5, 1, 1)].join("\n")).usage).toEqual({ input: 15, cached: 5, output: 3 });
    expect(parseEvents([usage(10, 2, 4), usage(5, 1)].join("\n")).usage).toEqual({ input: 15, cached: null, output: 3 });
    expect(parseEvents(usage(10, 2)).usage).toEqual({ input: 10, cached: null, output: 2 });
    expect(parseEvents(usage(0, 0, 0)).usage).toEqual({ input: 0, cached: 0, output: 0 });
    expect(parseEvents([usage(10, 2, 4), "", "garbage"].join("\n")).turns).toBe(1);
  });

  it("parses the documented Codex turn usage fields without estimating missing cache usage", () => {
    // https://developers.openai.com/blog/eval-skills: token usage is reported by turn.completed usage.
    const documented = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5000, output_tokens: 900 } });
    expect(parseEvents(documented).usage).toEqual({ input: 5000, cached: null, output: 900 });
  });

  it("agentSummary marks a condition NOT MEASURED when one run lacks usage, and counts the measured runs", () => {
    const runs = [
      { condition: "A", status: "completed", wallSeconds: 10, usage: { input: 100, cached: 0, output: 10 }, events: { checkRuns: 1, reworkCycles: 0, proposals: 0 }, duo: { contextTokens: null } },
      { condition: "A", status: "failed", wallSeconds: 12, usage: null, events: { checkRuns: 0, reworkCycles: 0, proposals: 0 }, duo: { contextTokens: null } },
      { condition: "B", status: "completed", wallSeconds: 8, usage: { input: 50, cached: null, output: 5 }, events: { checkRuns: 2, reworkCycles: 1, proposals: 0 }, duo: { contextTokens: null } },
    ];
    const s = agentSummary(runs);
    expect(s.A.inputTokens).toBeNull();
    expect(s.A.measuredRuns.inputTokens).toBe(1);
    expect(s.A.totalWallSeconds).toBe(22);
    expect(s.A.checkRuns).toBe(1);
    expect(s.B.inputTokens).toBe(50);
    expect(s.B.cachedInputTokens).toBeNull();
    expect(s.B.contextPacketTokens).toBeNull();
  });

  it("keeps stoppedToAsk NOT MEASURED until every run is classified", () => {
    const s = agentSummary([
      { condition: "A", oracle: { askedHuman: true } },
      { condition: "A", oracle: { askedHuman: null } },
      { condition: "B", oracle: { askedHuman: false } },
      { condition: "C", oracle: { askedHuman: true } },
      { condition: "C", oracle: { askedHuman: false } },
    ]);
    expect(s.A.stoppedToAsk).toBeNull();
    expect(s.A.measuredRuns.stoppedToAsk).toBe(1);
    expect(s.B.stoppedToAsk).toBe(0);
    expect(s.B.measuredRuns.stoppedToAsk).toBe(1);
    expect(s.C.stoppedToAsk).toBe(1);
    expect(s.C.measuredRuns.stoppedToAsk).toBe(2);
  });
});
