/**
 * T44 (F-07): planConfirmSession shows each proposal as it will be when its confirm runs and refuses proposals of one
 * session that depend on each other. It writes nothing in the repository.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DecisionActor } from "./files.js";
import { createDecisionService } from "./service.js";
import { planConfirmSession, sessionOrder } from "./session.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));
const human: DecisionActor = { kind: "human", name: "kanghyunsoon" };
const agent: DecisionActor = { kind: "agent", name: "codex" };
let root: string;
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
const snapshot = () => fs.readdirSync(path.join(root, ".duo-project"), { recursive: true, encoding: "utf8" }).filter((f) => !/^runtime/u.test(f)).sort()
  .map((f) => [f, fs.statSync(path.join(root, ".duo-project", f)).isFile() ? fs.readFileSync(path.join(root, ".duo-project", f), "utf8") : "<dir>"]);
const svc = () => createDecisionService({ root, clock: () => new Date("2026-10-07T00:00:00.000Z") });
/**
 * C255 (T53): the tests that run whole session simulations (Truth copy, preview and confirm per proposal, several
 * plans) take about 0.4 s alone and up to 3.1 s in the full suite, but went past the default 5 s under extra load
 * (7.1 s with a parallel MCP prober, 6.6 s with the CPU twice oversubscribed). They get their own limit; the rest keep
 * the default.
 */
const SIMULATION_TIMEOUT = 30_000;
const reviewed = async (ids: string[]) => Promise.all(ids.map(async (id) => ({ id, digest: (await svc().previewConfirm(id)).value?.digest ?? "" })));

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-session-")));
  temps.push(root);
  write(".duo-project/project.yaml", "schema_version: 1\nname: session\n");
  write(".duo-project/specs/auth.md", "# Auth\n\n## AUTH-01 Login\n\n```duo\nstatus: planned\n```\n\nUsers log in.\n");
  write(".duo-project/decisions/D-001.yaml", "id: D-001\ntitle: Password login\nkind: decision\nstate: proposed\nquestion: login_mechanism\nanswer: password\nenforcement: warn\n");
  expect((await svc().confirm(human, "D-001")).value?.decisionId).toBe("D-001");
  for (const [title, q] of [["Weekly rotation", "rotation"], ["Email reminders", "channel"], ["UTC times", "timezone"]] as const) {
    expect((await svc().propose(agent, { title, question: q, answer: "yes" })).value).toBeDefined();
  }
});

describe("planConfirmSession (T44, F-07)", () => {
  it("orders by proposal ID", () => {
    expect(sessionOrder(["P-010", "P-002", "P-001"])).toEqual(["P-001", "P-002", "P-010"]);
  });

  it("shows the later proposals stale (their candidate after the earlier confirms) and writes nothing", async () => {
    const before = snapshot();
    const plan = await planConfirmSession({ root }, await reviewed(["P-003", "P-001", "P-002"]));
    expect(plan.diagnostics).toEqual([]);
    const items = plan.value?.items ?? [];
    expect(items.map((i) => [i.id, i.preview.expectedDecisionId, i.changedFromReview, i.preview.stale?.truthChanged ?? false])).toEqual([
      ["P-001", "D-002", false, false], ["P-002", "D-003", true, true], ["P-003", "D-004", true, true],
    ]);
    expect(snapshot()).toEqual(before);
    // The real confirms bound to the plan digests succeed one by one with the ordinary confirm.
    for (const item of items) expect((await svc().confirm(human, item.id, { expectedDigest: item.preview.digest })).value?.decisionId).toBe(item.preview.expectedDecisionId);
  }, SIMULATION_TIMEOUT);

  it("refuses when a proposal changed after the review", async () => {
    const r = await reviewed(["P-001", "P-002"]);
    const file = path.join(root, ".duo-project/decisions/proposals/P-002.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("answer: yes", "answer: no"));
    const plan = await planConfirmSession({ root }, r);
    expect(plan.value).toBeUndefined();
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["DECISION_CONFIRM_PREVIEW_CHANGED"]);
  });

  it("refuses two proposals that supersede the same Decision, and one that supersedes a Decision the session creates", async () => {
    await svc().propose(agent, { title: "Passkey login", question: "login_mechanism", answer: "passkey", supersedes: "D-001" });
    await svc().propose(agent, { title: "SSO login", question: "login_mechanism", answer: "sso", supersedes: "D-001" });
    const twice = await planConfirmSession({ root }, await reviewed(["P-004", "P-005"]));
    expect(twice.value).toBeUndefined();
    expect(twice.diagnostics.map((d) => d.code)).toEqual(["DECISION_SESSION_CONFLICT", "DECISION_SUPERSEDE_TARGET_INVALID"]);
    expect(twice.diagnostics[0]?.message).toContain("P-005");
    // A hand-written proposal that supersedes D-002, which only the first proposal of this session would create.
    write(".duo-project/decisions/proposals/P-006.yaml", "id: P-006\ntitle: Later rotation\nstate: proposed\nquestion: rotation\nanswer: monthly\nsupersedes: D-002\nproposed_by: kim\nproposed_by_kind: human\nproposed_at: 2026-10-07T00:00:00.000Z\n");
    const dependent = await planConfirmSession({ root }, await reviewed(["P-001", "P-006"]));
    expect(dependent.diagnostics.map((d) => d.code)).toEqual(["DECISION_SESSION_CONFLICT"]);
    expect(dependent.diagnostics[0]?.message).toContain("supersedes D-002, which this session creates");
  }, SIMULATION_TIMEOUT);

  it("refuses duplicate, empty and non-proposal selections", async () => {
    expect((await planConfirmSession({ root }, [])).diagnostics.map((d) => d.code)).toEqual(["INVALID_ID"]);
    const r = await reviewed(["P-001"]);
    expect((await planConfirmSession({ root }, [...r, ...r])).diagnostics.map((d) => d.code)).toEqual(["INVALID_ID"]);
    expect((await planConfirmSession({ root }, [{ id: "D-001", digest: "x" }])).diagnostics.map((d) => d.code)).toEqual(["INVALID_ID"]);
  });
});
