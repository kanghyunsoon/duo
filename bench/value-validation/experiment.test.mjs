// Regression tests for Issue #67: an agent.mjs --out directory is resumed only with the exact experiment it was created
// for, and a mismatch leaves every existing file unchanged. No Codex is started: the end-to-end cases use --dry-run with
// condition A, and the dry-run -> real case is checked on openExperiment directly (a real run needs the paid-run flags).
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, experimentIdentity, fixtureDigest, openExperiment, taskDigest, templateProblems } from "./experiment.mjs";
import { TASKS } from "./tasks.mjs";

const AGENT = fileURLToPath(new URL("./agent.mjs", import.meta.url));
const BASE = { "--seed": "81", "--timeout-min": "20", "--reps": "1", "--tasks": "T1,T2", "--conditions": "A" };
let tmp = "";
let base = "";
let counter = 0;

function agent(out, change = {}, extra = []) {
  const args = Object.entries({ ...BASE, ...change }).flat();
  return spawnSync(process.execPath, [AGENT, "--dry-run", "--out", out, ...args, ...extra], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
}
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { out[path.relative(dir, f) + "/"] = "dir"; walk(f); } else out[path.relative(dir, f)] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } };
  walk(dir);
  return out;
}
function copy() { const d = path.join(tmp, "out-" + ++counter); fs.cpSync(base, d, { recursive: true }); return d; }
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
/** Runs agent.mjs on dir and expects a refusal that names the reason and leaves every file byte-identical. */
function expectRefused(dir, change, pattern) {
  const before = tree(dir);
  const r = agent(dir, change);
  expect(r.status, r.stdout + r.stderr).not.toBe(0);
  expect(r.stderr).toMatch(pattern);
  expect(r.stderr).toContain("--out <new dir>");
  expect(tree(dir)).toEqual(before);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv resume 67 "));
  base = path.join(tmp, "base");
  const r = agent(base);
  if (r.status !== 0) throw new Error("baseline dry run failed: " + r.stdout + r.stderr);
}, 120_000);
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe("experiment identity (#67)", () => {
  const task = { id: "T9", category: 2, expected: "x", prompt: "p", handoff: "h", acceptance: "a" };

  it("serializes stably: object key order does not matter, array order does", () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: undefined })).toBe(canonicalJson({ c: null, a: [2, 1], b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("taskDigest follows the task definitions, not only their IDs", () => {
    const d = taskDigest([task]);
    expect(taskDigest([{ acceptance: "a", handoff: "h", prompt: "p", expected: "x", category: 2, id: "T9" }])).toBe(d);
    for (const [k, v] of Object.entries({ prompt: "p2", handoff: "h2", acceptance: "a2", category: 3, expected: "y" })) expect(taskDigest([{ ...task, [k]: v }])).not.toBe(d);
    expect(taskDigest([{ ...task, handoff: undefined }])).not.toBe(d);
    expect(taskDigest([TASKS[0], TASKS[1]])).not.toBe(taskDigest([TASKS[1], TASKS[0]]));
  });

  it("fixtureDigest ignores line endings and follows content", () => {
    expect(fixtureDigest("a\r\nb\r\n")).toBe(fixtureDigest("a\nb\n"));
    expect(fixtureDigest("a\nb\n")).not.toBe(fixtureDigest("a\nc\n"));
  });

  it("records the DUO version only for an experiment with condition C, and the mode", () => {
    const ctx = { taskDefinitions: [task], fixtureVersion: "f/1", fixtureSource: "s", duoVersion: "0.3.3" };
    const opts = { dryRun: true, seed: 1, timeoutMin: 20, reps: 1, tasks: ["T9"] };
    expect(experimentIdentity({ ...opts, conditions: ["A"] }, ctx)).toMatchObject({ mode: "dry-run", model: null, duoVersion: null });
    expect(experimentIdentity({ ...opts, dryRun: false, model: "m", conditions: ["A", "C"] }, ctx)).toMatchObject({ mode: "real", model: "m", duoVersion: "0.3.3" });
  });

  it("dry-run results are never reused by a real run, and nothing is written", () => {
    const dir = copy();
    const saved = readJson(path.join(dir, "experiment.json")).identity;
    const before = tree(dir);
    expect(() => openExperiment(dir, { ...saved, mode: "real", model: "some-model" })).toThrow(/mode: "dry-run" \(saved\) -> "real" \(requested\)[\s\S]*Dry-run results are never reused by a real run[\s\S]*--out <new dir>/u);
    expect(tree(dir)).toEqual(before);
  });

  it("a cached template is checked for condition, fixture, DUO version (C), adoption commit and tracked changes", () => {
    const ok = { condition: "C", fixture: "f/1", duoVersion: "0.3.3", adoption: "abc" };
    const want = { condition: "C", fixtureVersion: "f/1", duoVersion: "0.3.3", head: "abc", trackedChanges: "" };
    expect(templateProblems(ok, want)).toEqual([]);
    expect(templateProblems({ ...ok, duoVersion: "0.3.2" }, want).join()).toMatch(/built with DUO "0\.3\.2"/u);
    expect(templateProblems({ ...ok, duoVersion: undefined }, want).join()).toMatch(/built with DUO null/u);
    expect(templateProblems({ ...ok, fixture: "f/0" }, want).join()).toMatch(/fixture "f\/0"/u);
    expect(templateProblems(ok, { ...want, head: "def" }).join()).toMatch(/HEAD is def/u);
    expect(templateProblems(ok, { ...want, trackedChanges: " M src/a.js" }).join()).toMatch(/uncommitted changes/u);
    expect(templateProblems(null, want)).toHaveLength(1);
    expect(templateProblems(ok, { ...want, condition: "A" }).join()).toMatch(/template A metadata is for condition "C"/u);
  });
});

describe("agent.mjs resume (#67, dry runs only)", () => {
  it("a new directory records experiment.json, and the same settings resume without changing anything", { timeout: 120_000 }, () => {
    const exp = readJson(path.join(base, "experiment.json"));
    expect(exp.format).toBe("duo.value-validation-experiment/1");
    expect(exp.identity).toMatchObject({ mode: "dry-run", model: null, seed: 81, timeoutMin: 20, reps: 1, tasks: ["T1", "T2"], conditions: ["A"], fixtureVersion: "value-validation-01/1", duoVersion: null });
    expect(exp.identity.taskDigest).toBe(taskDigest([TASKS[0], TASKS[1]]));
    expect(readJson(path.join(base, "runs.json")).runs.map((r) => r.status)).toEqual(["dry-run", "dry-run"]);
    const dir = copy();
    const before = tree(dir);
    const r = agent(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(tree(dir)).toEqual(before);
  });

  it.each([
    ["seed", { "--seed": "82" }, /seed: 81 \(saved\) -> 82/u],
    ["timeout", { "--timeout-min": "21" }, /timeoutMin: 20 \(saved\) -> 21/u],
    ["repetitions", { "--reps": "2" }, /reps: 1 \(saved\) -> 2/u],
    ["task list", { "--tasks": "T1" }, /tasks: \["T1","T2"\] \(saved\) -> \["T1"\][\s\S]*taskDigest/u],
    ["task order", { "--tasks": "T2,T1" }, /tasks: \["T1","T2"\] \(saved\) -> \["T2","T1"\]/u],
    ["conditions", { "--conditions": "A,B" }, /conditions: \["A"\] \(saved\) -> \["A","B"\]/u],
    ["model", { "--model": "other-model" }, /model: null \(saved\) -> "other-model"/u],
  ])("a changed %s is refused and leaves every file unchanged", { timeout: 120_000 }, (_name, change, pattern) => {
    expectRefused(copy(), change, pattern);
  });

  it.each([
    ["taskDigest", "sha256:0000", /taskDigest: "sha256:0000" \(saved\)/u],
    ["fixtureDigest", "sha256:0000", /fixtureDigest: "sha256:0000" \(saved\)/u],
    ["fixtureVersion", "value-validation-01/0", /fixtureVersion: "value-validation-01\/0" \(saved\)/u],
    ["duoVersion", "0.3.2", /duoVersion: "0\.3\.2" \(saved\) -> null/u],
    ["mode", "real", /mode: "real" \(saved\) -> "dry-run"/u],
  ])("a saved %s that differs from the current definitions is refused", { timeout: 120_000 }, (field, value, pattern) => {
    const dir = copy();
    const f = path.join(dir, "experiment.json");
    const exp = readJson(f); exp.identity[field] = value; writeJson(f, exp);
    expectRefused(dir, {}, pattern);
  });

  it("a directory with results but no experiment.json is refused", { timeout: 120_000 }, () => {
    const dir = copy();
    fs.rmSync(path.join(dir, "experiment.json"));
    expectRefused(dir, {}, /holds results \(schedule\.json, runs\.json, templates, runs\) but no experiment\.json/u);
  });

  it.each([
    ["unreadable JSON", "{", /experiment\.json cannot be read/u],
    ["another format", JSON.stringify({ format: "duo.value-validation-experiment/0", identity: {} }), /has format "duo\.value-validation-experiment\/0"/u],
    ["no identity", JSON.stringify({ format: "duo.value-validation-experiment/1" }), /has no identity/u],
  ])("an experiment.json with %s is refused", { timeout: 120_000 }, (_name, text, pattern) => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, "experiment.json"), text);
    expectRefused(dir, {}, pattern);
  });

  it("a cached template that changed is refused before anything is rebuilt", { timeout: 120_000 }, () => {
    const meta = copy();
    const f = path.join(meta, "templates", "A.json"); const m = readJson(f); m.fixture = "value-validation-01/0"; writeJson(f, m);
    expectRefused(meta, {}, /template A was built from fixture "value-validation-01\/0"/u);

    const edited = copy();
    fs.appendFileSync(path.join(edited, "templates", "A", "README.md"), "edited\n");
    expectRefused(edited, {}, /template A has uncommitted changes to tracked files/u);

    const committed = copy();
    const root = path.join(committed, "templates", "A");
    fs.appendFileSync(path.join(root, "README.md"), "edited\n");
    for (const g of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "edit"]]) spawnSync("git", g, { cwd: root });
    expectRefused(committed, {}, /template A HEAD is [0-9a-f]{40}, not its recorded adoption commit/u);
  });

  it("an interrupted run (directory without a record) is reported, kept and not rerun", { timeout: 120_000 }, () => {
    const dir = copy();
    const f = path.join(dir, "runs.json"); const res = readJson(f); const lost = res.runs.pop(); writeJson(f, res);
    expectRefused(dir, {}, new RegExp("interrupted \\(a run directory without a record in runs\\.json\\): " + lost.id, "u"));
    expect(fs.existsSync(path.join(dir, "runs", lost.id))).toBe(true);
  });

  it("a recorded run that this experiment could not have produced is refused", { timeout: 120_000 }, () => {
    const dir = copy();
    const f = path.join(dir, "runs.json"); const res = readJson(f); res.runs[0].status = "completed"; writeJson(f, res);
    expectRefused(dir, {}, /has status "completed", which a dry-run experiment does not record/u);
  });
});

