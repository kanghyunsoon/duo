// Regression tests for the Claude Code final-result parser (S15P31A106-280, #28). Fixtures in fixtures/claude/ follow
// the result and stream shapes in the official Claude Code docs (headless mode, Agent SDK cost tracking and TypeScript
// SDKResultMessage, read 2026-10-23, CLI 2.1.263) with made-up numbers and redacted text. auth-failed.real.jsonl (OAuth
// expired, no model call) and real-stream.jsonl (a successful run) are real CLI 2.1.263 stream-json runs reduced to an
// allow-list of structural and numeric fields.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaudeResult } from "./claude-measure.mjs";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/claude/${name}`, import.meta.url), "utf8");
const result = (extra) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 10, duration_api_ms: 5, total_cost_usd: 0.01, usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }, ...extra });
const expected = { input: 12, cacheCreation: 9876, cacheRead: 45210, output: 734 };

describe("Claude Code final result parser (NOT MEASURED rule)", () => {
  it("reads tokens, both durations and the cost estimate from --output-format json, keeping the two cache fields apart", () => {
    expect(parseClaudeResult(fixture("result.json"))).toEqual({
      resultCount: 1, subtype: "success", isError: false, numTurns: 3, durationMs: 41250, durationApiMs: 30310, usage: expected, costUsdEstimate: 0.0815,
    });
  });

  it("reads only the final result of a stream-json run, never summing assistant events", () => {
    const s = parseClaudeResult(fixture("stream.jsonl"));
    expect(s.usage).toEqual(expected);
    expect(s.durationMs).toBe(41250);
    expect(parseClaudeResult(fixture("stream.jsonl").replace(/\n/gu, "\r\n")).usage).toEqual(expected);
  });

  it("a real run: result usage differs from summed assistant events, and events after the result are ignored", () => {
    const text = fixture("real-stream.jsonl");
    expect(parseClaudeResult(text)).toEqual({
      resultCount: 1, subtype: "success", isError: false, numTurns: 3, durationMs: 8857, durationApiMs: 4920,
      usage: { input: 4, cacheCreation: 60177, cacheRead: 59856, output: 184 }, costUsdEstimate: 0.2545272,
    });
    const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const assistant = events.filter((e) => e.type === "assistant");
    expect(assistant.reduce((p, e) => p + e.message.usage.output_tokens, 0)).toBe(7); // placeholders, not 184
    expect(assistant.reduce((p, e) => p + e.message.usage.cache_creation_input_tokens, 0)).toBe(179889); // msg_1 three times
    expect(events.at(-1).type).not.toBe("result");
  });

  it("a stream cut before its result, or no output, is NOT MEASURED", () => {
    for (const text of [fixture("truncated.jsonl"), "", "not json", JSON.stringify({ type: "assistant" })]) {
      const s = parseClaudeResult(text);
      expect(s.resultCount).toBe(0);
      expect(s.usage).toBeNull();
      expect(s.durationMs).toBeNull();
      expect(s.costUsdEstimate).toBeNull();
    }
  });

  it("several results (turns with different scopes) are NOT MEASURED rather than added up", () => {
    const s = parseClaudeResult([result(), result()].join("\n"));
    expect(s.resultCount).toBe(2);
    expect(s.usage).toBeNull();
    expect(s.durationMs).toBeNull();
  });

  it("a missing field is null on its own, never 0, and a missing usage object is null", () => {
    const s = parseClaudeResult(result({ usage: { input_tokens: 7, output_tokens: 9 }, duration_api_ms: undefined, total_cost_usd: "0.01" }));
    expect(s.usage).toEqual({ input: 7, cacheCreation: null, cacheRead: null, output: 9 });
    expect(s.durationApiMs).toBeNull();
    expect(s.durationMs).toBe(10);
    expect(s.costUsdEstimate).toBeNull();
    expect(parseClaudeResult(result({ usage: null })).usage).toBeNull();
  });

  it("a real zero stays a measured zero", () => {
    const s = parseClaudeResult(result({ usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
    expect(s.usage).toEqual({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 });
    expect(s.costUsdEstimate).toBe(0);
  });

  it("crash and budget-stop results keep their times but report usage and cost as NOT MEASURED", () => {
    for (const subtype of ["error_during_execution", "error_max_budget_usd"]) {
      const s = parseClaudeResult(result({ subtype, is_error: true, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
      expect(s.subtype).toBe(subtype);
      expect(s.isError).toBe(true);
      expect(s.usage).toBeNull();
      expect(s.costUsdEstimate).toBeNull();
      expect(s.durationMs).toBe(10);
    }
    expect(parseClaudeResult(result({ subtype: "error_max_turns", is_error: true })).usage).toEqual({ input: 1, cacheCreation: 2, cacheRead: 3, output: 4 });
  });

  it("a real run that failed on an API error reports zeros under subtype success; they are NOT MEASURED, not 0", () => {
    const s = parseClaudeResult(fixture("auth-failed.real.jsonl"));
    expect(s).toEqual({ resultCount: 1, subtype: "success", isError: true, numTurns: 1, durationMs: 2043, durationApiMs: 0, usage: null, costUsdEstimate: null });
    expect(parseClaudeResult(result({ terminal_reason: "api_error" })).usage).toBeNull();
    expect(parseClaudeResult(result({ terminal_reason: "completed" })).usage).toEqual({ input: 1, cacheCreation: 2, cacheRead: 3, output: 4 });
  });
});
