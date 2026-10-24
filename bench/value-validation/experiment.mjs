// Value Validation 01: the experiment identity behind an agent.mjs --out directory (Issue #67).
// A directory holds one experiment. Its settings are written once to experiment.json and checked on every resume before
// anything else in the directory is read for reuse or written. Any difference fails without touching existing files;
// a different experiment needs a new --out directory. Nothing here migrates, rewrites or deletes earlier results.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EXPERIMENT_FORMAT = "duo.value-validation-experiment/1";
export const RESULTS_FORMAT = "duo.value-validation-agents/1";
/** Entries that mean the directory already holds an experiment (selftest output does not count). */
const RESULT_ENTRIES = ["schedule.json", "runs.json", "templates", "runs"];
const RUN_STATUS = { "dry-run": ["dry-run"], real: ["completed", "failed", "timeout", "kill-failed"] };
const NEW_OUT = "Use the original settings to resume, or start this experiment in a new directory with --out <new dir>. Nothing in the existing directory was changed.";

/** JSON with object keys sorted at every level; array order is kept. undefined becomes null. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  return JSON.stringify(value ?? null);
}

export const sha256 = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** Digest of the task definitions in run order: everything an agent or the evaluation sees, not only the IDs. */
export function taskDigest(tasks) {
  return sha256(canonicalJson(tasks.map((t) => ({ id: t.id, category: t.category, expected: t.expected, prompt: t.prompt, handoff: t.handoff ?? null, acceptance: t.acceptance ?? null }))));
}

/** Digest of the fixture definition and generator source; line endings are normalized so a checkout's EOL does not count. */
export const fixtureDigest = (source) => sha256(source.replace(/\r\n/gu, "\n"));

export function experimentIdentity({ dryRun, model, seed, timeoutMin, reps, tasks, conditions }, { taskDefinitions, fixtureVersion, fixtureSource, duoVersion }) {
  return {
    mode: dryRun ? "dry-run" : "real", model: model ?? null, seed, timeoutMin, reps, tasks: [...tasks], conditions: [...conditions],
    fixtureVersion, fixtureDigest: fixtureDigest(fixtureSource), duoVersion: conditions.includes("C") ? duoVersion : null, taskDigest: taskDigest(taskDefinitions),
  };
}

const show = (v) => { const s = canonicalJson(v); return s.length > 80 ? s.slice(0, 77) + "..." : s; };
const fail = (out, what) => new Error(out + ": " + what + "\n" + NEW_OUT);

/**
 * Creates experiment.json in a new directory, or checks it in an existing one. Throws, without writing, when the
 * directory holds results but no experiment.json, when experiment.json is unreadable or of another format, or when any
 * identity field differs (the error lists each field as saved -> requested).
 */
export function openExperiment(out, identity) {
  const file = path.join(out, "experiment.json");
  if (!fs.existsSync(file)) {
    const found = RESULT_ENTRIES.filter((e) => fs.existsSync(path.join(out, e)));
    if (found.length > 0) throw fail(out, "holds results (" + found.join(", ") + ") but no experiment.json, so the settings they were made with cannot be checked.");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ format: EXPERIMENT_FORMAT, createdAt: new Date().toISOString(), identity }, null, 2) + "\n", { flag: "wx" });
    return { created: true };
  }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw fail(out, "experiment.json cannot be read (" + String(error.message ?? error) + ")."); }
  if (saved === null || typeof saved !== "object" || saved.format !== EXPERIMENT_FORMAT) throw fail(out, "experiment.json has format " + show(saved?.format) + ", expected " + EXPERIMENT_FORMAT + ".");
  if (saved.identity === null || typeof saved.identity !== "object" || Array.isArray(saved.identity)) throw fail(out, "experiment.json has no identity.");
  const keys = [...new Set([...Object.keys(identity), ...Object.keys(saved.identity)])];
  const diffs = keys.filter((k) => canonicalJson(saved.identity[k]) !== canonicalJson(identity[k]));
  if (diffs.length > 0) {
    const lines = diffs.map((k) => "  " + k + ": " + show(saved.identity[k]) + " (saved) -> " + show(identity[k]) + " (requested)");
    const note = diffs.includes("mode") ? "\nDry-run results are never reused by a real run, and real results are never reused by a dry run." : "";
    throw fail(out, "was created with different experiment settings:\n" + lines.join("\n") + note);
  }
  return { created: false };
}

/**
 * Checks runs.json and the run directories against the plan before anything is resumed. Returns the recorded runs and
 * the IDs to skip. A run directory without a record is an interrupted run: it is reported, not deleted or rerun.
 */
export function checkResults(out, plan, identity) {
  const file = path.join(out, "runs.json");
  const planned = new Set(plan.map((r) => r.id));
  let results;
  if (fs.existsSync(file)) {
    try { results = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw fail(out, "runs.json cannot be read (" + String(error.message ?? error) + ")."); }
    if (results?.format !== RESULTS_FORMAT || !Array.isArray(results.runs)) throw fail(out, "runs.json has format " + show(results?.format) + ", expected " + RESULTS_FORMAT + ".");
  }
  const runs = results?.runs ?? [];
  const problems = [];
  const seen = new Set();
  for (const r of runs) {
    if (seen.has(r?.id)) problems.push(r?.id + " is recorded twice");
    seen.add(r?.id);
    if (!planned.has(r?.id)) problems.push(r?.id + " is not in this experiment's schedule");
    if (!RUN_STATUS[identity.mode].includes(r?.status)) problems.push(r?.id + " has status " + show(r?.status) + ", which a " + identity.mode + " experiment does not record");
    if ((r?.model ?? null) !== identity.model) problems.push(r?.id + " was run with model " + show(r?.model ?? null));
  }
  const runsDir = path.join(out, "runs");
  const interrupted = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((id) => !seen.has(id)).sort() : [];
  if (interrupted.length > 0) problems.push("interrupted (a run directory without a record in runs.json): " + interrupted.join(", ") + ". Keep or move these directories deliberately; they are not rerun or deleted automatically");
  if (problems.length > 0) throw fail(out, "runs.json does not match this experiment:\n  " + problems.join("\n  "));
  return { results, done: seen };
}

/** Problems with a cached template before it is reused (empty when it can be reused). */
export function templateProblems(info, { condition, fixtureVersion, duoVersion, head, trackedChanges }) {
  if (info === null || typeof info !== "object") return ["template " + condition + " has no readable metadata"];
  const p = [];
  if (info.condition !== condition) p.push("template " + condition + " metadata is for condition " + show(info.condition));
  if (info.fixture !== fixtureVersion) p.push("template " + condition + " was built from fixture " + show(info.fixture) + ", not " + fixtureVersion);
  if (condition === "C" && info.duoVersion !== duoVersion) p.push("template C was built with DUO " + show(info.duoVersion ?? null) + ", not " + duoVersion);
  if (info.adoption !== head) p.push("template " + condition + " HEAD is " + head + ", not its recorded adoption commit " + show(info.adoption));
  if (trackedChanges !== "") p.push("template " + condition + " has uncommitted changes to tracked files");
  return p;
}

export function templateError(out, problems) { return fail(out, "cached templates cannot be reused:\n  " + problems.join("\n  ")); }

