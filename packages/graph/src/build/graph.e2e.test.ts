import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeId, type EntityRef } from "@duo-director/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkGraph } from "../check.js";
import { openNodeSqliteGraphStore } from "../store/node-sqlite/node-sqlite-graph-store.js";
import type { GraphStore } from "../store/types.js";
import { traverse } from "../traverse.js";
import { applyGraphPlan } from "./apply.js";
import { buildGraphPlan } from "./builder.js";
import { collectGraphFacts } from "./collect.js";
import type { GraphBuildInput, GraphBuildPlan } from "./types.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXTURE = fileURLToPathSafe(new URL("../../../../fixtures/graph/app/", import.meta.url));
function fileURLToPathSafe(u: URL): string {
  return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
}
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "DUO Test", GIT_AUTHOR_EMAIL: "test@duo.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "DUO Test", GIT_COMMITTER_EMAIL: "test@duo.invalid", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
function repoFromFixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-graph-e2e-")));
  temps.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true });
  git("-c", "init.defaultBranch=main", "init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init APP-10");
  const touch = (message: string) => {
    for (const f of ["src/auth/login.ts", "src/app.ts"]) fs.appendFileSync(path.join(root, f), `// ${message}\n`);
    git("commit", "-q", "-am", message);
  };
  touch("APP-10 tweak");
  touch("UTF-8 fix");
  touch("more");
  git("checkout", "-q", "-b", "feature/APP-10-login");
  return root;
}

let input: GraphBuildInput;
let plan: GraphBuildPlan;
let store: GraphStore;
const edges = () => new Set(plan.edges.map((e) => `${nodeId(e.from)} -${e.type}-> ${nodeId(e.to)}`));
const has = (from: string, type: string, to: string) => edges().has(`${from} -${type}-> ${to}`);
const edgeMeta = (from: string, type: string, to: string) => plan.edges.find((e) => nodeId(e.from) === from && e.type === type && nodeId(e.to) === to)?.metadata;
const call = (calleeText: string) => plan.callResolutions.filter((c) => c.calleeText === calleeText).map((c) => [c.path, c.status, c.reason ?? null, c.target?.symbol ?? null]);

beforeAll(async () => {
  const root = repoFromFixture();
  const facts = await collectGraphFacts(root);
  if (facts.value === undefined) throw new Error(JSON.stringify(facts.diagnostics));
  input = facts.value;
  plan = buildGraphPlan(input);
  const opened = openNodeSqliteGraphStore({ path: ":memory:" });
  if (opened.value === undefined) throw new Error("no store");
  store = opened.value;
  expect(applyGraphPlan(store, plan).diagnostics).toEqual([]);
});
afterAll(() => store?.close());

describe("Project Graph E2E (TASK-007)", () => {
  it("stores exactly the planned graph and passes graph.check()", () => {
    expect(plan.valid).toBe(true);
    expect(store.counts()).toEqual({ nodes: plan.nodes.length, edges: plan.edges.length });
    expect(checkGraph(store, { fingerprints: input.files })).toEqual([]);
  });

  it("builds definition nodes and declared relations; Project Truth files are not File nodes", () => {
    const ids = new Set(plan.nodes.map((n) => nodeId(n.ref)));
    for (const id of ["project:root", "ms:M1", "req:APP-01", "req:APP-02", "dec:D-001", "dec:D-002", "issue:APP-10"]) expect(ids).toContain(id);
    expect([...ids].some((id) => id.startsWith("file:.duo-project/"))).toBe(false);
    expect(has("dec:D-002", "SUPERSEDES", "dec:D-001")).toBe(true);
    expect(has("dec:D-002", "GOVERNS", "req:APP-01")).toBe(true);
    expect(has("dec:D-002", "GOVERNS", "issue:APP-10")).toBe(true);
    expect(has("req:APP-01", "TRACKED_BY", "issue:APP-10")).toBe(true);
    expect(has("ms:M1", "REQUIRES", "req:APP-01")).toBe(true);
    expect(has("req:APP-02", "REQUIRES", "req:APP-01")).toBe(true);
    expect(has("project:root", "CONTAINS", "ms:M1")).toBe(true);
    expect(has("dec:D-001", "GOVERNS", "file:src/auth/login.ts")).toBe(true);
    expect(has("file:src/auth/session.ts", "IMPLEMENTS", "req:APP-02")).toBe(true);
  });

  it("IMPORTS only for modules resolved to one repository file", () => {
    for (const to of ["src/auth/index.ts", "src/auth/login.ts", "src/auth/session.ts", "src/shared/format.ts", "src/util/index.ts", "src/chain/a.ts", "src/chain/near.ts"]) {
      expect(has("file:src/app.ts", "IMPORTS", `file:${to}`)).toBe(true);
    }
    expect(has("file:src/legacy.js", "IMPORTS", "file:src/shared/format.ts")).toBe(true);
    const byTarget = Object.fromEntries(plan.moduleResolutions.filter((m) => m.from === "src/app.ts").map((m) => [m.specifier, m.result.status]));
    expect(byTarget).toMatchObject({ "left-pad": "external", "./missing.js": "unresolved", "@shared/format.js": "resolved", "./auth/index.js": "resolved" });
    expect(edgeMeta("file:src/app.ts", "IMPORTS", "file:src/auth/login.ts")).toMatchObject({ provenance: "static", resolution: "typescript-resolution", extensionSubstituted: true });
    expect(plan.diagnostics.filter((d) => d.code === "MODULE_UNRESOLVED").map((d) => d.source?.path)).toEqual(["src/app.ts"]);
  });

  it("CALLS only for exact resolutions", () => {
    const main = "sym:src/app.ts#main";
    for (const target of [
      "sym:src/auth/login.ts#login", "sym:src/auth/session.ts#createSession", "sym:src/auth/session.ts#Session",
      "sym:src/auth/session.ts#Session.static.load", "sym:src/shared/format.ts#format", "sym:src/util/index.ts#util", "sym:src/chain/f.ts#deep",
    ]) expect(has(main, "CALLS", target)).toBe(true);
    expect(has("sym:src/auth/login.ts#login", "CALLS", "sym:src/auth/login.ts#validate")).toBe(true);
    expect(has("sym:src/auth/session.ts#Session.save", "CALLS", "sym:src/auth/session.ts#Session.validate")).toBe(true);
    expect(has("sym:src/auth/session.ts#createSession", "CALLS", "sym:src/auth/session.ts#Session.static.load")).toBe(true);
    expect(has("sym:src/legacy.js#legacy", "CALLS", "sym:src/shared/format.ts#format")).toBe(true);
    // login, runLogin (alias) and Auth.login (namespace) are one edge with three call sites.
    expect(edgeMeta(main, "CALLS", "sym:src/auth/login.ts#login")).toMatchObject({ resolution: "exact", callSites: 3 });
    expect(call("s.save")).toEqual([["src/app.ts", "unresolved", "local-binding", null]]);
    expect(call("leftPad")).toEqual([["src/app.ts", "unresolved", "external-module", null]]);
    expect(call("missing")).toEqual([["src/app.ts", "unresolved", "module-unresolved", null]]);
    // deep through a.ts → b → c → d → e → f is longer than the re-export limit; near.ts → f is not.
    expect(call("deep")).toEqual([["src/app.ts", "unresolved", "export-unresolved", null]]);
    expect(call("nearDeep")).toEqual([["src/app.ts", "exact", null, "deep"]]);
    const callEdges = plan.edges.filter((e) => e.type === "CALLS");
    expect(callEdges.every((e) => e.metadata?.resolution === "exact")).toBe(true);
  });

  it("attaches annotations to the next symbol, the file, or reports unknown IDs", () => {
    expect(edgeMeta("sym:src/auth/login.ts#login", "IMPLEMENTS", "req:APP-01")).toMatchObject({ provenance: "declared", basis: ["annotation", "implements.symbols"] });
    expect(has("file:src/app.ts", "IMPLEMENTS", "req:APP-02")).toBe(true);
    expect(plan.diagnostics.filter((d) => d.code === "ANNOTATION_TARGET_UNKNOWN").map((d) => [d.source?.path, d.source?.startLine])).toEqual([["src/auth/login.ts", 10]]);
    expect(plan.stats.annotations).toEqual({ symbol: 1, test: 1, file: 1, unknownId: 1, unsupportedId: 0 });
  });

  it("Test nodes and VALIDATED_BY from exact calls, declared patterns and annotations", () => {
    const logsIn = "test:test/app.test.ts#App > logs in";
    const keeps = "test:test/app.test.ts#App > keeps the session";
    expect(has("file:test/app.test.ts", "CONTAINS", logsIn)).toBe(true);
    expect(has("sym:src/auth/login.ts#login", "VALIDATED_BY", logsIn)).toBe(true);
    // helper() is a test helper; format is only reached through it.
    expect(has("sym:test/app.test.ts#helper", "VALIDATED_BY", logsIn)).toBe(false);
    expect(has("sym:src/shared/format.ts#format", "VALIDATED_BY", logsIn)).toBe(false);
    expect(has("req:APP-01", "VALIDATED_BY", logsIn)).toBe(true);
    expect(has("req:APP-02", "VALIDATED_BY", keeps)).toBe(true);
  });

  it("CHANGED_WITH only above the co-change threshold, as historical correlation", () => {
    const changed = plan.edges.filter((e) => e.type === "CHANGED_WITH").map((e) => `${nodeId(e.from)} → ${nodeId(e.to)}`);
    expect(changed).toEqual(["file:src/app.ts → file:src/auth/login.ts", "file:src/auth/login.ts → file:src/app.ts"]);
    expect(edgeMeta("file:src/app.ts", "CHANGED_WITH", "file:src/auth/login.ts")).toEqual({ provenance: "git", correlation: "historical", count: 4 });
  });

  it("uses Git Issue candidates only when Project Truth has the Issue", () => {
    const issue = plan.nodes.find((n) => nodeId(n.ref) === "issue:APP-10");
    expect(issue?.payload?.commits).toHaveLength(2);
    const project = plan.nodes.find((n) => nodeId(n.ref) === "project:root");
    expect(project?.payload?.git).toMatchObject({ branch: "feature/APP-10-login", branchIssueIds: ["APP-10"] });
    expect(plan.nodes.some((n) => n.ref.type === "issue" && n.ref.id === "UTF-8")).toBe(false);
  });

  it("is deterministic regardless of fact order", () => {
    const shuffled = buildGraphPlan({ ...input, files: [...input.files].reverse(), analyses: [...input.analyses].reverse() });
    expect(JSON.stringify(shuffled.nodes)).toBe(JSON.stringify(plan.nodes));
    expect(JSON.stringify(shuffled.edges)).toBe(JSON.stringify(plan.edges));
  });

  it("reports resolution metrics", () => {
    // app.ts 8, legacy.js 1, auth/index.ts 2, chain/* 6, app.test.ts 2 resolved; left-pad and vitest external; ./missing.js unresolved.
    expect(plan.stats.modules).toEqual({ resolved: 19, external: 2, unresolved: 1, ambiguous: 0, unsupported: 0 });
    expect(plan.stats.calls.heuristic).toBe(0);
    expect(plan.stats.calls.exact).toBeGreaterThan(0);
  });

  it("traverses from a Requirement to code", () => {
    const r = traverse(store, [{ type: "requirement", id: "APP-01" } as EntityRef], { maxDepth: 1, nodeLimit: 100, direction: "incoming", edgeTypes: ["IMPLEMENTS"] });
    expect(r.nodes.map((n) => n.node.id)).toEqual(["req:APP-01", "sym:src/auth/login.ts#login"]);
  });
});
