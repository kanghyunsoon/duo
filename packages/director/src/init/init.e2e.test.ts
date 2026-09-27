import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { loadProjectTruth } from "@duo-director/core";
import { inspectIndex, openProjectGraphStore } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contextRegistry, HISTORY, INIT_FIXTURE, INIT_GOLDEN, makeContextRepo, type ContextRepo } from "../context/testing.js";
import { applyInitPlan, nodeInitFileSystem, type InitFileSystem } from "./apply.js";
import { initPlanDigest, planInit } from "./plan.js";
import type { InitAnswer, InitPlan } from "./types.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const FENCE = "\u0060\u0060\u0060";
const temps: string[] = [];
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await contextRegistry(); });
afterAll(() => {
  registry?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const fresh = () => makeContextRepo(temps, registry, INIT_FIXTURE);
const tempDir = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
};

/** Every file and directory under root except .git, with file bytes. */
function snapshot(root: string): [string, string][] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => !f.split(path.sep).includes(".git")).sort()
    .map((f) => {
      const st = fs.lstatSync(path.join(root, f));
      return [f.split(path.sep).join("/"), st.isFile() ? fs.readFileSync(path.join(root, f)).toString("base64") : st.isSymbolicLink() ? "<link>" : "<dir>"];
    });
}

async function plan(root: string): Promise<InitPlan> {
  const p = await planInit(root);
  if (p.value === undefined) throw new Error(JSON.stringify(p.diagnostics));
  return p.value;
}

/** Files under .duo-project written by init, repository-relative. */
function stateFiles(root: string): Record<string, string> {
  const dir = path.join(root, ".duo-project");
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => f.split(path.sep).join("/")).sort()
    .map((f) => [".duo-project/" + f, fs.readFileSync(path.join(dir, f), "utf8")]));
}

/** AC-014-01: compares with fixtures/init/expected/<name>.json (DUO_UPDATE_GOLDEN=1 rewrites it). */
function golden(name: string, value: unknown): void {
  const file = path.join(INIT_GOLDEN, name + ".json");
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.DUO_UPDATE_GOLDEN === "1") {
    fs.mkdirSync(INIT_GOLDEN, { recursive: true });
    fs.writeFileSync(file, text);
  }
  expect(text).toBe(fs.readFileSync(file, "utf8").replace(/\r\n/gu, "\n"));
}

const ANSWERS: InitAnswer[] = [
  { question: "project_goal", value: "Settle shared household expenses fairly, with a clear record of who paid what." },
  { question: "current_milestone", title: "MVP: record expenses and settle a month" },
  { question: "critical_constraints", statements: ["No bank account integration in the MVP", "All amounts are integer cents"] },
];

describe("planInit (TASK-014)", () => {
  it("requires the top level of a Git work tree: non-Git is GIT_REPOSITORY_REQUIRED, a subdirectory SCAN_ROOT_INVALID", async () => {
    const plain = tempDir("duo-init-nogit-");
    fs.cpSync(INIT_FIXTURE, plain, { recursive: true });
    expect((await planInit(plain)).diagnostics.map((d) => d.code)).toEqual(["GIT_REPOSITORY_REQUIRED"]);
    const repo = fresh();
    expect((await planInit(path.join(repo.root, "src"))).diagnostics.map((d) => d.code)).toEqual(["SCAN_ROOT_INVALID"]);
    expect(fs.existsSync(path.join(repo.root, "src", ".duo-project"))).toBe(false);
  });

  it("is read-only and deterministic: the same repository state gives the same plan (golden)", async () => {
    const repo = fresh();
    const before = snapshot(repo.root);
    const p = await plan(repo.root);
    expect(snapshot(repo.root)).toEqual(before);
    expect(p).toMatchObject({ state: "not-initialized", applicable: true, requiresRepair: false, blockers: [], existing: [], conflicts: [], indexRequired: true });
    const again = await plan(fresh().root);
    expect(again.digest).toBe(p.digest);
    golden("plan", p);
  });

  it("observes repository facts without turning them into intent", async () => {
    const p = await plan(fresh().root);
    expect(p.observed).toMatchObject({
      provenance: "observed", name: { value: "pocket-ledger", source: { path: "package.json", field: "name" } },
      git: { branch: "main", detached: false, unborn: false },
      languages: [{ language: "typescript", files: 4, analyzed: true }],
      packageManager: { value: "pnpm" }, workspaces: [],
      scripts: [{ name: "build", run: "pnpm run build" }, { name: "lint", run: "pnpm run lint" }, { name: "test", run: "pnpm run test" }],
      technical: [{ field: "engines.node", value: ">=24.15.0" }, { field: "packageManager", value: "pnpm@11.25.0" }],
      sourceRoots: [{ path: "src", files: 3 }], testRoots: [{ path: "tests", files: 1 }], colocatedTests: 0,
    });
    expect(p.observed.manifests.map((m) => m.path)).toEqual(["package.json", "tsconfig.json"]);
    // Script command text is not copied; technical facts are not constraints.
    expect(JSON.stringify(p)).not.toContain("vitest run");
    expect(p.questions.find((q) => q.id === "critical_constraints")?.suggestedValue).toBeUndefined();
  });

  it("finds a bounded, ranked set of candidate documents and import candidates", async () => {
    const p = await plan(fresh().root);
    expect(p.documents.map((d) => [d.path, d.kind, d.score])).toEqual([
      ["README.md", "readme", 100],
      ["CONTRIBUTING.md", "contributing", 80],
      ["docs/architecture.md", "design", 80],
      ["docs/legacy-spec.md", "design", 80],
      ["docs/notes/meeting-2026-09.md", "docs", 55],
    ]);
    expect(p.importCandidates).toEqual([{ status: "candidate", path: "docs/legacy-spec.md", hash: expect.stringMatching(/^sha256:/u), definitions: [{ kind: "requirement", id: "LEDGER-01", title: "Split expenses evenly" }] }]);
    const capped = await planInit(fresh().root, { discovery: { maxDocuments: 2 } });
    expect(capped.value?.documents.map((d) => d.path)).toEqual(["README.md", "CONTRIBUTING.md"]);
    // A root planning document, also in Korean ("기획서" contains the keyword "기획").
    const korean = fresh();
    korean.write("Ledger 기획서.md", "# 기획\n\n가계부 정산.\n");
    korean.write("NOTES.md", "# Notes\n");
    const ranked = (await plan(korean.root)).documents.map((d) => [d.path, d.kind, d.score, d.reasons.join(" ")]);
    expect(ranked).toContainEqual(["Ledger 기획서.md", "design", 80, "root-document keyword:기획"]);
    expect(ranked).toContainEqual(["NOTES.md", "other", 60, "root-document"]);
  });

  it("asks only what observation cannot answer; a README paragraph is a suggestion, not Truth", async () => {
    const p = await plan(fresh().root);
    expect(p.questions).toEqual([
      { id: "project_goal", kind: "text", promptKey: "init.question.project_goal", required: true,
        suggestedValue: "Pocket Ledger tracks shared household expenses and settles who owes whom at the end of the month.",
        evidence: [{ path: "README.md", hash: expect.stringMatching(/^sha256:/u) }] },
      { id: "current_milestone", kind: "milestone", promptKey: "init.question.current_milestone", required: false },
      { id: "critical_constraints", kind: "list", promptKey: "init.question.critical_constraints", required: false },
    ]);
    expect(p.willCreate.map((f) => [f.path, f.when])).toEqual([
      [".duo-project/project.yaml", "always"], [".duo-project/.gitignore", "always"], [".duo-project/intent/vision.md", "always"],
      [".duo-project/intent/constraints.yaml", "always"], [".duo-project/milestones/M1.yaml", "answered"],
    ]);
  });

  it("never reads secret files as suggestion sources and keeps their content out of the plan", async () => {
    const repo = fresh();
    repo.write(".env", "API_KEY=sk-live-0123456789\n");
    repo.write("docs/credentials.md", "# Credentials\n\nThe admin password is hunter2.\n");
    const p = await plan(repo.root);
    const text = JSON.stringify(p);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("credentials.md");
    expect(p.observed.files.excluded).toMatchObject({ secret: 2 });
  });
});

describe("applyInitPlan (TASK-014)", () => {
  it("writes the confirmed human answers; the core loader reads the result; the Graph is untouched (golden)", async () => {
    const repo = fresh();
    const p = await plan(repo.root);
    const r = await applyInitPlan(repo.root, p, ANSWERS);
    expect(r.diagnostics).toEqual([]);
    expect(r.value).toMatchObject({ state: "initialized", openQuestions: [], indexRequired: true, llmCalls: 0, kept: [] });
    const files = stateFiles(repo.root);
    golden("answered", files);
    expect(Object.keys(files)).not.toContain(".duo-project/generated/gaps.json");
    for (const d of ["specs", "decisions/proposals", "milestones", "integrations", "reviews", "generated", "cache", "runtime"]) {
      expect(fs.statSync(path.join(repo.root, ".duo-project", d)).isDirectory()).toBe(true);
    }
    expect(fs.readdirSync(path.join(repo.root, ".duo-project", "generated"))).toEqual([]);
    expect(fs.readdirSync(path.join(repo.root, ".duo-project", "runtime"))).toEqual([]);
    const loaded = loadProjectTruth(repo.root);
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(loaded.value?.truth).toMatchObject({
      config: { name: "pocket-ledger", currentMilestone: "M1" }, vision: { status: "confirmed", owner: "human", sources: [] },
      milestones: [{ id: "M1", title: "MVP: record expenses and settle a month", state: "active" }],
      constraints: [{ id: "CON-001", state: "confirmed", enforcement: "warn" }, { id: "CON-002", statement: "All amounts are integer cents" }],
      requirements: [], gaps: [],
    });
    // Init does not index: the index is missing until the caller runs the Indexer.
    const opened = openProjectGraphStore(repo.root);
    expect((await inspectIndex(repo.root, { graph: opened.value as never, registry, historyWindow: HISTORY })).value?.status).toBe("missing");
    opened.value?.close();
  });

  it("without answers: a draft vision with UNKNOWN lines, no suggestion text, no milestone, empty constraints (golden)", async () => {
    const repo = fresh();
    const p = await plan(repo.root);
    const r = await applyInitPlan(repo.root, p, []);
    expect(r.value?.openQuestions).toEqual(["project_goal", "current_milestone", "critical_constraints"]);
    const files = stateFiles(repo.root);
    golden("unanswered", files);
    expect(files[".duo-project/intent/vision.md"]).not.toContain("Pocket Ledger tracks");
    const truth = loadProjectTruth(repo.root).value?.truth;
    expect(truth).toMatchObject({ config: { currentMilestone: null }, vision: { status: "draft" }, constraints: [], milestones: [] });
    expect(truth?.gaps.map((g) => [g.owner.type, g.key])).toEqual([["project", "project_goal"], ["project", "current_milestone"], ["project", "critical_constraints"]]);
  });

  it("an accepted suggestion becomes confirmed with its README provenance; a changed value cannot claim it", async () => {
    const repo = fresh();
    const p = await plan(repo.root);
    const q = p.questions[0];
    const wrong = await applyInitPlan(repo.root, p, [{ question: "project_goal", value: "Something else", acceptSuggestion: true }]);
    expect(wrong.diagnostics.map((d) => d.code)).toEqual(["INIT_ANSWER_INVALID"]);
    expect(fs.existsSync(path.join(repo.root, ".duo-project"))).toBe(false);
    const ok = await applyInitPlan(repo.root, p, [{ question: "project_goal", value: q?.suggestedValue ?? "", acceptSuggestion: true }]);
    expect(ok.value?.openQuestions).toEqual(["current_milestone", "critical_constraints"]);
    expect(loadProjectTruth(repo.root).value?.truth.vision).toMatchObject({ status: "confirmed", sources: [{ kind: "external", path: "README.md", hash: q?.evidence?.[0]?.hash }] });
  });

  it("an initialized repository is refused and left unchanged; a second init never resets Truth", async () => {
    const repo = fresh();
    const first = await plan(repo.root);
    await applyInitPlan(repo.root, first, ANSWERS);
    const before = snapshot(repo.root);
    const second = await plan(repo.root);
    expect(second).toMatchObject({ state: "initialized", applicable: false, questions: [], willCreate: [], blockers: [{ code: "INIT_ALREADY_INITIALIZED" }] });
    expect((await applyInitPlan(repo.root, second, [])).diagnostics.map((d) => d.code)).toEqual(["INIT_ALREADY_INITIALIZED"]);
    expect((await applyInitPlan(repo.root, first, [])).diagnostics.map((d) => d.code)).toEqual(["INIT_PLAN_STALE"]);
    expect(snapshot(repo.root)).toEqual(before);
  });

  it("an incompatible project.yaml is refused", async () => {
    const repo = fresh();
    repo.write(".duo-project/project.yaml", "schema_version: 99\nname: x\n");
    const p = await plan(repo.root);
    expect(p).toMatchObject({ state: "incompatible", applicable: false, blockers: [{ code: "INIT_INCOMPATIBLE" }] });
    expect(p.blockers[0]?.message).toContain("UNSUPPORTED_SCHEMA_VERSION");
    expect((await applyInitPlan(repo.root, p, ANSWERS)).diagnostics.map((d) => d.code)).toEqual(["INIT_INCOMPATIBLE"]);
  });

  it("a partial .duo-project needs an explicit repair, which adds only the missing files", async () => {
    const repo = fresh();
    const spec = "# Ledger\n\n## LEDGER-01 Split expenses\n\n" + FENCE + "duo\nstatus: planned\n" + FENCE + "\n\nSplit evenly.\n";
    repo.write(".duo-project/specs/ledger.md", spec);
    repo.write(".duo-project/intent/vision.md", "---\nstatus: confirmed\nowner: human\n---\n\n# Vision\n\nKeep households even.\n");
    const p = await plan(repo.root);
    expect(p).toMatchObject({ state: "partial", applicable: true, requiresRepair: true, existing: [".duo-project/intent/vision.md", ".duo-project/specs/ledger.md"] });
    expect(p.missing).toEqual([".duo-project/project.yaml", ".duo-project/.gitignore", ".duo-project/intent/constraints.yaml", ".duo-project/milestones/M1.yaml"]);
    expect(p.questions.map((q) => q.id)).toEqual(["current_milestone", "critical_constraints"]);
    expect((await applyInitPlan(repo.root, p, [])).diagnostics.map((d) => d.code)).toEqual(["INIT_REPAIR_REQUIRED"]);
    const r = await applyInitPlan(repo.root, p, [{ question: "critical_constraints", statements: [] }], { repair: true });
    expect(r.value).toMatchObject({ kept: [".duo-project/intent/vision.md", ".duo-project/specs/ledger.md"], openQuestions: ["current_milestone"] });
    expect(repo.read(".duo-project/specs/ledger.md")).toBe(spec);
    expect(loadProjectTruth(repo.root).value?.truth.requirements.map((x) => x.id)).toEqual(["LEDGER-01"]);
  });

  it("rolls back every created file and directory when writing fails, and when the staged Truth does not load", async () => {
    const repo = fresh();
    const before = snapshot(repo.root);
    const p = await plan(repo.root);
    let placed = 0;
    const failing: InitFileSystem = { ...nodeInitFileSystem, place: async (a, b) => { if (++placed === 3) throw new Error("disk full"); await nodeInitFileSystem.place(a, b); } };
    const r = await applyInitPlan(repo.root, p, ANSWERS, { fs: failing });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["INIT_APPLY_FAILED"]);
    expect(snapshot(repo.root)).toEqual(before);
    const corrupt: InitFileSystem = { ...nodeInitFileSystem, writeFile: (a, t) => nodeInitFileSystem.writeFile(a, a.endsWith("project.yaml") ? "schema_version: 99\nname: x\n" : t) };
    const v = await applyInitPlan(repo.root, p, ANSWERS, { fs: corrupt });
    expect(v.diagnostics[0]?.code).toBe("INIT_VALIDATION_FAILED");
    expect(snapshot(repo.root)).toEqual(before);
  });

  it("never writes through a symlink or outside the repository", async () => {
    const outside = tempDir("duo-init-outside-");
    const linked = fresh();
    fs.symlinkSync(outside, path.join(linked.root, ".duo-project"), "junction");
    const p = await plan(linked.root);
    expect(p).toMatchObject({ state: "partial", applicable: false, conflicts: [{ path: ".duo-project", reason: "symlink" }], blockers: [{ code: "INIT_CONFLICT" }] });
    expect((await applyInitPlan(linked.root, p, ANSWERS, { repair: true })).value).toBeUndefined();
    expect(fs.readdirSync(outside)).toEqual([]);

    // A link swapped in after planning: the plan is stale and nothing is written.
    const raced = fresh();
    const planned = await plan(raced.root);
    fs.symlinkSync(outside, path.join(raced.root, ".duo-project"), "junction");
    expect((await applyInitPlan(raced.root, planned, ANSWERS)).diagnostics.map((d) => d.code)).toEqual(["INIT_PLAN_STALE"]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a tampered plan: unknown or traversing paths, a forged milestone ID, a plain digest mismatch", async () => {
    const repo = fresh();
    const p = await plan(repo.root);
    const reseal = (x: Omit<InitPlan, "digest">): InitPlan => ({ ...x, digest: initPlanDigest(x) });
    const traversal = reseal({ ...p, willCreate: [...p.willCreate, { path: ".duo-project/../src/evil.ts" as never, kind: "project-truth", when: "always" }] });
    const sourceFile = reseal({ ...p, willCreate: [...p.willCreate, { path: "src/evil.ts" as never, kind: "project-truth", when: "always" }] });
    const forged = reseal({ ...p, allocations: { milestone: "../../M1" } });
    for (const bad of [traversal, sourceFile, forged, { ...p, basis: "sha256:0" }]) {
      expect((await applyInitPlan(repo.root, bad, ANSWERS)).diagnostics.map((d) => d.code)).toEqual(["INIT_PLAN_INVALID"]);
    }
    expect(fs.existsSync(path.join(repo.root, ".duo-project"))).toBe(false);
    expect(fs.existsSync(path.join(repo.root, "src", "evil.ts"))).toBe(false);
  });
});

describe("init → index (TASK-014 integration)", () => {
  it("after apply, the caller's Indexer builds the Graph of the new project", async () => {
    const repo: ContextRepo = fresh();
    const p = await plan(repo.root);
    expect((await applyInitPlan(repo.root, p, ANSWERS)).value?.indexRequired).toBe(true);
    await repo.index();
    const rows = repo.graphDump().nodes;
    for (const id of ["project:root", "ms:M1", "file:src/settle.ts", "sym:src/settle.ts#balances", "test:tests/settle.test.ts#"]) {
      expect(rows.some((row) => row.includes(id))).toBe(true);
    }
    const opened = openProjectGraphStore(repo.root);
    expect((await inspectIndex(repo.root, { graph: opened.value as never, registry, historyWindow: HISTORY })).value?.status).toBe("current");
    opened.value?.close();
    expect(fs.existsSync(path.join(repo.root, ".duo-project/generated/gaps.json"))).toBe(false);
  });

  it("works on a copy of the DUO repository itself (self-init), without touching its documents", async () => {
    const duo = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = tempDir("duo-self-init-");
    const copy = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.copyFileSync(path.join(duo, rel), path.join(root, rel)); };
    for (const f of ["README.md", "package.json", "pnpm-workspace.yaml"]) copy(f);
    for (const f of fs.readdirSync(path.join(duo, "docs"), { recursive: true, encoding: "utf8" })) if (f.endsWith(".md")) copy(path.join("docs", f));
    for (const pkg of ["core", "analyzer", "graph", "director", "integration", "ui"]) copy(path.join("packages", pkg, "package.json"));
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@duo.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@duo.invalid" };
    for (const args of [["-c", "init.defaultBranch=main", "init", "-q"], ["config", "core.autocrlf", "false"], ["config", "commit.gpgsign", "false"], ["add", "-A"], ["commit", "-qm", "copy"]]) {
      execFileSync("git", args, { cwd: root, env, windowsHide: true });
    }
    const docsBefore = snapshot(path.join(root, "docs"));
    const p = await plan(root);
    expect(p).toMatchObject({ state: "not-initialized", applicable: true, observed: { name: { value: "duo-director-workspace" }, packageManager: { value: "pnpm" } } });
    expect(p.observed.workspaces.map((w) => w.manifest)).toEqual(["pnpm-workspace.yaml"]);
    expect(p.documents.length).toBeLessThanOrEqual(20);
    expect(p.importCandidates.flatMap((c) => c.definitions.map((d) => d.id))).toContain("REQ-INIT-001");
    const r = await applyInitPlan(root, p, [{ question: "project_goal", value: "Keep coding agents aligned with confirmed project intent." }]);
    expect(r.value?.state).toBe("initialized");
    expect(loadProjectTruth(root).value?.truth.requirements).toEqual([]); // import candidates are not imported
    expect(snapshot(path.join(root, "docs"))).toEqual(docsBefore);
  });
});

