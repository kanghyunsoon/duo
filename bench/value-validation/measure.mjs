// Value Validation 01: pure measurement helpers shared by agent.mjs and aggregate.mjs (no side effects on import).
// The protocol's NOT MEASURED rule: a value that was not observed is null, never 0, and a total or a median over runs
// is null as soon as one expected run value is missing (a partial total would understate a condition's cost).
import fs from "node:fs";

const isNumber = (x) => typeof x === "number" && Number.isFinite(x);

/** Total of every value, or null when there are none or any value is missing (not a number). */
export function sumAll(xs) {
  if (xs.length === 0 || !xs.every(isNumber)) return null;
  return xs.reduce((p, q) => p + q, 0);
}

/** Median (lower middle) of every value, or null when there are none or any value is missing. */
export function medianAll(xs) {
  if (xs.length === 0 || !xs.every(isNumber)) return null;
  const v = [...xs].sort((p, q) => p - q);
  return v[Math.floor((v.length - 1) / 2)];
}

/** How many values are numbers (reported next to a total so a missing run is visible). */
export const countMeasured = (xs) => xs.filter(isNumber).length;

/**
 * Parses a codex exec --json event stream. usage is null unless every turn.completed event carried numeric input and
 * output token counts: an early exit, a cut stream or one incomplete usage event makes the total NOT MEASURED instead
 * of a partial sum. cached is null unless every usage event reported cached_input_tokens. Lines that are not JSON are
 * ignored.
 */
export function parseEvents(text) {
  const ev = { turns: 0, usage: null, commands: [], fileChanges: 0, mcp: [], checkRuns: 0, failedChecks: 0, reworkCycles: 0, proposals: 0, finalMessage: "" };
  let input = 0; let output = 0; let cached = 0; let cachedEverywhere = true; let incomplete = false; let failing = false;
  for (const line of text.split(/\r?\n/u)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e === null || typeof e !== "object") continue;
    if (e.type === "turn.completed") {
      ev.turns++;
      const u = e.usage;
      if (u === null || typeof u !== "object" || !isNumber(u.input_tokens) || !isNumber(u.output_tokens)) incomplete = true;
      else {
        input += u.input_tokens; output += u.output_tokens;
        if (isNumber(u.cached_input_tokens)) cached += u.cached_input_tokens; else cachedEverywhere = false;
      }
    }
    if (e.type !== "item.completed" || e.item === undefined || e.item === null) continue;
    const it = e.item;
    if (it.type === "command_execution") {
      ev.commands.push({ command: String(it.command).slice(0, 300), exit: it.exit_code ?? null });
      if (/npm run check|eslint|check-deps|duoctl (review|index)/u.test(it.command)) { ev.checkRuns++; if ((it.exit_code ?? 0) !== 0) { ev.failedChecks++; failing = true; } else failing = false; }
    }
    if (it.type === "mcp_tool_call") { ev.mcp.push({ server: it.server, tool: it.tool, status: it.status }); if (it.tool === "duo_review_changes") ev.checkRuns++; if (it.tool === "duo_propose_decision") ev.proposals++; }
    if (it.type === "file_change") { ev.fileChanges++; if (failing) { ev.reworkCycles++; failing = false; } }
    if (it.type === "agent_message") ev.finalMessage = String(it.text ?? "");
  }
  if (ev.turns > 0 && !incomplete) ev.usage = { input, cached: cachedEverywhere ? cached : null, output };
  return ev;
}

/** parseEvents over a file; a missing file has no usage either. */
export function readEvents(file) {
  return parseEvents(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
}

/** Per agent run: totals and medians by condition (null = NOT MEASURED), with the number of runs that had each value. */
export function agentSummary(runs) {
  const by = {};
  for (const r of runs) (by[r.condition] ??= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([c, rs]) => {
    const col = (f) => rs.map(f);
    const wall = col((r) => r.wallSeconds);
    const stopped = col((r) => typeof r.oracle?.askedHuman === "boolean" ? Number(r.oracle.askedHuman) : null);
    return [c, {
      runs: rs.length, completed: rs.filter((r) => r.status === "completed").length,
      medianWallSeconds: medianAll(wall), totalWallSeconds: sumAll(wall),
      inputTokens: sumAll(col((r) => r.usage?.input)), cachedInputTokens: sumAll(col((r) => r.usage?.cached)), outputTokens: sumAll(col((r) => r.usage?.output)),
      contextPacketTokens: sumAll(col((r) => r.duo?.contextTokens)),
      violationsLeft: rs.filter((r) => r.oracle?.violations > 0).length, needsHumanReview: rs.filter((r) => r.oracle?.needsReview === true).length,
      testsPassing: rs.filter((r) => r.tests?.ok === true).length, checkRuns: sumAll(col((r) => r.events?.checkRuns)), reworkCycles: sumAll(col((r) => r.events?.reworkCycles)),
      stoppedToAsk: sumAll(stopped), proposals: sumAll(col((r) => r.events?.proposals)),
      measuredRuns: {
        wallSeconds: countMeasured(wall), inputTokens: countMeasured(col((r) => r.usage?.input)), cachedInputTokens: countMeasured(col((r) => r.usage?.cached)),
        outputTokens: countMeasured(col((r) => r.usage?.output)), contextPacketTokens: countMeasured(col((r) => r.duo?.contextTokens)), stoppedToAsk: countMeasured(stopped),
      },
    }];
  }));
}
