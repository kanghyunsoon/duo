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
import { canonicalJson, claimRunDir, experimentIdentity, fixtureDigest, harnessDigest, openExperiment, repeatedRunIds, selectionProblems, taskDigest, templateProblems } from "./experiment.mjs";
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
    const ctx = { taskDefinitions: [task], fixtureVersion: "f/1", fixtureSource: "s", duoVersion: "0.3.3", harnessSources: { "agent.mjs": "x" }, codexVersion: "codex-cli 1.0.0" };
    const opts = { dryRun: true, seed: 1, timeoutMin: 20, reps: 1, tasks: ["T9"] };
    expect(experimentIdentity({ ...opts, conditions: ["A"] }, ctx)).toMatchObject({ mode: "dry-run", model: null, duoVersion: null, codexVersion: null });
    expect(experimentIdentity({ ...opts, dryRun: false, model: "m", conditions: ["A", "C"] }, ctx)).toMatchObject({ mode: "real", model: "m", duoVersion: "0.3.3", codexVersion: "codex-cli 1.0.0" });
  });

  it("harnessDigest follows the code that runs and judges runs, not file order or line endings (#74 review)", () => {
    const d = harnessDigest({ "oracle.mjs": "a\n", "agent.mjs": "b\n" });
    expect(harnessDigest({ "agent.mjs": "b\r\n", "oracle.mjs": "a\r\n" })).toBe(d);
    expect(harnessDigest({ "oracle.mjs": "a2\n", "agent.mjs": "b\n" })).not.toBe(d);
    expect(harnessDigest({ "oracle.mjs": "a\n", "agent.mjs": "b\n", "process.mjs": "c\n" })).not.toBe(d);
  });

  it("repeated task, condition or run IDs are found before a run is scheduled (#74 review)", () => {
    const known = ["T1", "T2"];
    expect(selectionProblems({ tasks: ["T1", "T2"], conditions: ["A", "B"] }, known)).toEqual([]);
    expect(selectionProblems({ tasks: ["T1", "T1"], conditions: ["A"] }, known)).toEqual(["task listed more than once: T1"]);
    expect(selectionProblems({ tasks: ["T1"], conditions: ["A", "A"] }, known)).toEqual(["condition listed more than once: A"]);
    expect(selectionProblems({ tasks: ["T9"], conditions: ["D"] }, known)).toEqual(["unknown task or condition: T9, D"]);
    expect(repeatedRunIds([{ id: "T1-A-r1" }, { id: "T1-B-r1" }, { id: "T1-A-r1" }])).toEqual(["T1-A-r1"]);
  });

  it("a run directory that already exists is never reused or replaced", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "claim-"));
    const run = path.join(dir, "runs", "T1-A-r1");
    claimRunDir(run);
    fs.writeFileSync(path.join(run, "session-1.events.jsonl"), "paid output\n");
    const before = tree(dir);
    expect(() => claimRunDir(run)).toThrow(/already exists; a run is never started again in the same directory/u);
    expect(tree(dir)).toEqual(before);
  });

  it("dry-run results are never reused by a real run, and nothing is written", () => {
    const dir = copy();
    const saved = readJson(path.join(dir, "experiment.json")).identity;
    const before = tree(dir);
    expect(() => openExperiment(dir, { ...saved, mode: "real", model: "some-model" })).toThrow(/mode: "dry-run" \(saved\) -> "real" \(requested\)[\s\S]*Dry-run results are never reused by a real run[\s\S]*--out <new dir>/u);
    expect(tree(dir)).toEqual(before);
  });

  it("a cached template is checked for condition, fixture, DUO version (C), adoption commit and working-tree changes", () => {
    const ok = { condition: "C", fixture: "f/1", duoVersion: "0.3.3", adoption: "abc" };
    const want = { condition: "C", fixtureVersion: "f/1", duoVersion: "0.3.3", head: "abc", changes: "" };
    expect(templateProblems(ok, want)).toEqual([]);
    expect(templateProblems({ ...ok, duoVersion: "0.3.2" }, want).join()).toMatch(/built with DUO "0\.3\.2"/u);
    expect(templateProblems({ ...ok, duoVersion: undefined }, want).join()).toMatch(/built with DUO null/u);
    expect(templateProblems({ ...ok, fixture: "f/0" }, want).join()).toMatch(/fixture "f\/0"/u);
    expect(templateProblems(ok, { ...want, head: "def" }).join()).toMatch(/HEAD is def/u);
    expect(templateProblems(ok, { ...want, changes: " M src/a.js" }).join()).toMatch(/uncommitted changes or untracked files: {2}M src\/a\.js/u);
    expect(templateProblems(ok, { ...want, changes: "?? src/ui/debug.js" }).join()).toMatch(/\?\? src\/ui\/debug\.js/u);
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
    ["harnessDigest", "sha256:0000", /harnessDigest: "sha256:0000" \(saved\)/u],
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
    expectRefused(edited, {}, /template A has uncommitted changes or untracked files: +M README\.md/u);

    const committed = copy();
    const root = path.join(committed, "templates", "A");
    fs.appendFileSync(path.join(root, "README.md"), "edited\n");
    for (const g of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "edit"]]) spawnSync("git", g, { cwd: root });
    expectRefused(committed, {}, /template A HEAD is [0-9a-f]{40}, not its recorded adoption commit/u);
  });

  it("an untracked file added to a cached template is refused; an ignored one is not (#74 review)", { timeout: 120_000 }, () => {
    const added = copy();
    fs.mkdirSync(path.join(added, "templates", "A", "src", "ui"), { recursive: true });
    fs.writeFileSync(path.join(added, "templates", "A", "src", "ui", "debug.js"), "import \"../db/legacy-db.js\";\n");
    expectRefused(added, {}, /template A has uncommitted changes or untracked files: \?\? src\/ui\/debug\.js/u);

    const ignored = copy();
    fs.mkdirSync(path.join(ignored, "templates", "A", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(ignored, "templates", "A", "node_modules", "x", "index.js"), "\n");
    const before = tree(ignored);
    const r = agent(ignored);
    expect(r.status, r.stderr).toBe(0);
    expect(tree(ignored)).toEqual(before);
  });

  it.each([["--tasks", { "--tasks": "T1,T1" }, /task listed more than once: T1/u], ["--conditions", { "--conditions": "A,A" }, /condition listed more than once: A/u]])("a repeated ID in %s is refused before anything is written", { timeout: 120_000 }, (_name, change, pattern) => {
    const fresh = path.join(tmp, "fresh-" + ++counter);
    const r = agent(fresh, change);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(pattern);
    expect(fs.readdirSync(fresh)).toEqual([]);
    const dir = copy();
    const before = tree(dir);
    const again = agent(dir, change);
    expect(again.stderr).toMatch(pattern);
    expect(tree(dir)).toEqual(before);
  });

  it("a stray file in runs/ is listed, not treated as an interrupted run (#74 review)", { timeout: 120_000 }, () => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, "runs", ".DS_Store"), "x");
    fs.mkdirSync(path.join(dir, "runs", "notes"));
    const before = tree(dir);
    const r = agent(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("not runs of this experiment (left as they are): .DS_Store, notes");
    expect(tree(dir)).toEqual(before);
  });

  it("a template whose earlier build did not finish is rebuilt with the same settings (#74 review)", { timeout: 120_000 }, () => {
    const dir = copy();
    fs.rmSync(path.join(dir, "templates", "A"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, "templates", "A.json"));
    fs.mkdirSync(path.join(dir, "templates", ".A.building", ".git"), { recursive: true });
    const runs = readJson(path.join(dir, "runs.json"));
    const r = agent(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, "templates", ".A.building"))).toBe(false);
    expect(readJson(path.join(dir, "templates", "A.json")).condition).toBe("A");
    expect(readJson(path.join(dir, "runs.json"))).toEqual(runs);
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

