// Value Validation 01: pure parser for the final `result` message of `claude -p --output-format json|stream-json`
// (S15P31A106-280, #28). Verification only: no harness runs Claude Code yet. Same NOT MEASURED rule as measure.mjs:
// a value that was not observed is null, never 0. Only the final result is read; assistant events are never summed
// (their usage repeats across messages of one response and their output_tokens is a placeholder).
// Field meanings: docs/validation/value-validation-01/measurement-notes.md.

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Results whose usage is documented as zeroed (session crash) or partial (the response that crossed the budget). */
const UNRELIABLE_USAGE = new Set(["error_during_execution", "error_max_budget_usd"]);

/**
 * True when the result's usage and cost cannot be trusted: the documented subtypes above, or an API error. A real
 * CLI 2.1.263 run that failed to authenticate ended with subtype "success", is_error true, terminal_reason "api_error"
 * and every token count 0 (fixtures/claude/auth-failed.real.jsonl).
 */
const unreliableUsage = (r) => UNRELIABLE_USAGE.has(r.subtype) || r.terminal_reason === "api_error" || (r.is_error === true && r.subtype === "success");

/** Every result message in a single JSON document (--output-format json) or a JSON Lines stream (stream-json). */
function results(text) {
  try {
    const one = JSON.parse(text);
    return one !== null && typeof one === "object" && one.type === "result" ? [one] : [];
  } catch { /* not one document: read it as a stream */ }
  const out = [];
  for (const line of text.split(/\r?\n/u)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e !== null && typeof e === "object" && e.type === "result") out.push(e);
  }
  return out;
}

/**
 * Tokens and times of one Claude Code run. Everything is null (NOT MEASURED) unless the output holds exactly one
 * result message: none means a cut or failed stream, several means turns whose scopes differ (per-turn usage, running
 * cost). Each token field is kept apart (cache creation and cache read are priced differently) and is null on its own
 * when missing. usage and cost are null for a crash, budget-stop or API-error result. costUsdEstimate is the CLI's client-side
 * estimate, not billing data.
 */
export function parseClaudeResult(text) {
  const rs = results(text);
  const out = { resultCount: rs.length, subtype: null, isError: null, numTurns: null, durationMs: null, durationApiMs: null, usage: null, costUsdEstimate: null };
  if (rs.length !== 1) return out;
  const r = rs[0];
  Object.assign(out, {
    subtype: typeof r.subtype === "string" ? r.subtype : null, isError: typeof r.is_error === "boolean" ? r.is_error : null,
    numTurns: num(r.num_turns), durationMs: num(r.duration_ms), durationApiMs: num(r.duration_api_ms),
  });
  if (unreliableUsage(r)) return out;
  const u = r.usage;
  if (u !== null && typeof u === "object") {
    out.usage = { input: num(u.input_tokens), cacheCreation: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens) };
  }
  out.costUsdEstimate = num(r.total_cost_usd);
  return out;
}
