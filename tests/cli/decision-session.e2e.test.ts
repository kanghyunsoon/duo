/**
 * duoctl decision review-pending (T44, F-07), in process with a scripted terminal: one session reviews every pending
 * proposal and confirms the chosen ones. Human-only, terminal-only, nothing by default, each confirm digest-bound.
 */
import fs from "node:fs";
import path from "node:path";
import { createDecisionService, loadProjectTruth } from "@duo-director/core";
import { EXPECTED_MCP_TOOLS } from "@duo-director/integration";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../../apps/cli/src/cli.js";
import { existingProject, type Project } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

type Answer = string | undefined | (() => string | undefined);
/** A terminal that answers prompts in order (a function runs first, e.g. to change a file) and records what was asked. */
function terminal(root: string, answers: Answer[], tty = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    out: (l) => out.push(l), err: (l) => err.push(l), isTTY: tty,
    prompt: (q) => { asked.push(q); const a = answers.shift(); return Promise.resolve(typeof a === "function" ? a() : a); },
    readStdin: () => Promise.resolve(""), cwd: () => root, now: () => new Date("2026-10-07T00:00:00Z"), env: {},
  };
  return { io, out, err, asked, json: () => JSON.parse(out.join("\n")) };
}
const agent = { kind: "agent" as const, name: "codex" };
const PROPOSALS = [["Weekly rotation", "rotation_period"], ["Email reminders", "reminder_channel"], ["UTC times", "time_zone"], ["Two reviewers", "review_count"], ["No cloud sync", "cloud_sync"]] as const;

let p: Project;
const dir = () => path.join(p.root, ".duo-project", "decisions");
const decisions = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).filter((f) => /^D-\d+\.yaml$/u.test(f)).sort() : []);
const pending = () => fs.existsSync(path.join(dir(), "proposals")) ? fs.readdirSync(path.join(dir(), "proposals")).sort() : [];
async function propose(n: number) {
  const s = createDecisionService({ root: p.root });
  for (const [title, question] of PROPOSALS.slice(0, n)) expect((await s.propose(agent, { title, question, answer: "yes" })).value).toBeDefined();
}

beforeEach(async () => {
  p = existingProject(temps);
  expect(await run(["init", "--yes", "--non-interactive"], terminal(p.root, [], false).io)).toBe(0);
});

describe("duoctl decision review-pending (T44)", () => {
  it("needs a terminal and a human; with nothing pending it says so", async () => {
    await propose(2);
    const noTty = terminal(p.root, ["all", "P-001 P-002"], false);
    expect(await run(["decision", "review-pending"], noTty.io)).toBe(1);
    expect(noTty.err.join("\n")).toContain("interactive terminal");
    expect(noTty.asked).toEqual([]);
    const flag = terminal(p.root, ["all", "P-001 P-002"]);
    expect(await run(["decision", "review-pending", "--non-interactive"], flag.io)).toBe(1);
    expect(flag.asked).toEqual([]);
    expect(decisions()).toEqual([]);
    // The confirm authority stays human-only and MCP has no approval tool.
    expect((await createDecisionService({ root: p.root }).confirm(agent, "P-001")).diagnostics.map((d) => d.code)).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
    expect(EXPECTED_MCP_TOOLS).toHaveLength(9);
    expect(EXPECTED_MCP_TOOLS.some((t) => /confirm|reject|approve/u.test(t))).toBe(false);

    const q = existingProject(temps);
    expect(await run(["init", "--yes", "--non-interactive"], terminal(q.root, [], false).io)).toBe(0);
    const none = terminal(q.root, []);
    expect(await run(["decision", "review-pending"], none.io)).toBe(0);
    expect(none.out.join("\n")).toContain("No pending decisions.");
    expect(none.asked).toEqual([]);
  });

  it("one pending: the full preview, the choice, the IDs typed again, then the ordinary confirm", async () => {
    await propose(1);
    const term = terminal(p.root, ["P-001", "P-001"]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(0);
    const shown = term.err.join("\n");
    for (const row of ["Title", "Question", "Answer", "Enforcement", "Supersedes", "Proposed by   codex (agent)", "Stale         no", "Expected ID", "File"]) expect(shown).toContain(row);
    expect(term.asked.length).toBe(2);
    expect(decisions()).toEqual(["D-001.yaml"]);
    const d = fs.readFileSync(path.join(dir(), "D-001.yaml"), "utf8");
    for (const field of ["proposal: P-001", "proposed_by: codex", "proposed_by_kind: agent", "confirmed_by: Ada Lovelace", "lock:"]) expect(d).toContain(field);
    expect(d).not.toMatch(/batch|session/u);
  });

  it("five pending, three chosen: later ones are shown stale before the retype; the two others stay pending and have no authority", async () => {
    await propose(5);
    const term = terminal(p.root, ["P-001 P-003 P-004", "P-001 P-003 P-004"]);
    expect(await run(["decision", "review-pending", "--json"], term.io)).toBe(0);
    const shown = term.err.join("\n");
    expect(shown).toContain("Review: 5 pending proposal(s) in ID order: P-001, P-002, P-003, P-004, P-005");
    expect(shown.match(/^\[\d\/5\]$/gmu)).toHaveLength(5);
    expect(shown).toContain("P-003 → D-002 (expected)");
    expect(shown).toContain("P-003 at the moment of its confirm");
    expect(shown).toContain("+ Stale         yes, Project Truth changed since this proposal was made");
    expect(shown).not.toContain("P-001 at the moment of its confirm");
    const r = term.json().result;
    expect(r.status).toBe("confirmed");
    expect(r.session).toMatchObject({ mode: "ids", selected: ["P-001", "P-003", "P-004"], pending: ["P-002", "P-005"], failed: [] });
    expect(r.session.confirmed.map((c: { proposalId: string; decisionId: string }) => [c.proposalId, c.decisionId])).toEqual([["P-001", "D-001"], ["P-003", "D-002"], ["P-004", "D-003"]]);
    expect(pending()).toEqual(["P-002.yaml", "P-005.yaml"]);
    const truth = loadProjectTruth(p.root).value?.truth;
    expect(truth?.decisions.filter((d) => d.state === "confirmed").map((d) => d.proposalId)).toEqual(["P-001", "P-003", "P-004"]);
    expect(truth?.proposals.map((x) => [x.id, x.state])).toEqual([["P-002", "proposed"], ["P-005", "proposed"]]);
  });

  it("all: every pending proposal after the retype", async () => {
    await propose(3);
    const term = terminal(p.root, ["all", "P-001 P-002 P-003"]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(0);
    expect(decisions()).toEqual(["D-001.yaml", "D-002.yaml", "D-003.yaml"]);
    expect(term.out.join("\n")).toContain("Confirmed 3 of 3. Still pending: (none).");
  });

  it("cancel at either prompt, end of input and a wrong retype confirm nothing", async () => {
    await propose(2);
    for (const answers of [[""], [undefined], ["cancel"], ["all", ""], ["all", undefined]] as Answer[][]) {
      const term = terminal(p.root, answers);
      expect(await run(["decision", "review-pending"], term.io)).toBe(0);
      expect(term.out.join("\n")).toContain("Nothing confirmed");
    }
    for (const answers of [["all", "P-002 P-001"], ["all", "all"], ["P-001 P-009"], ["P-001 P-001"], ["yes"]] as Answer[][]) {
      expect(await run(["decision", "review-pending"], terminal(p.root, answers).io)).toBe(1);
    }
    expect(decisions()).toEqual([]);
    expect(pending()).toEqual(["P-001.yaml", "P-002.yaml"]);
  });

  it("a proposal changed after the plan fails on its own; the others are confirmed as shown", async () => {
    await propose(3);
    const file = path.join(dir(), "proposals", "P-002.yaml");
    const term = terminal(p.root, ["all", () => { fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("answer: \"yes\"", "answer: \"no\"").replace("answer: yes", "answer: no")); return "P-001 P-002 P-003"; }]);
    expect(await run(["decision", "review-pending", "--json"], term.io)).toBe(1);
    const r = term.json().result;
    expect(r.status).toBe("partial");
    expect(r.session.failed).toEqual([{ proposalId: "P-002", diagnostics: ["DECISION_CONFIRM_PREVIEW_CHANGED"] }]);
    expect(r.session.confirmed.map((c: { proposalId: string }) => c.proposalId)).toEqual(["P-001", "P-003"]);
    expect(pending()).toEqual(["P-002.yaml"]);
  });

  it("a proposal changed between the review and the choice refuses the session", async () => {
    await propose(2);
    const file = path.join(dir(), "proposals", "P-001.yaml");
    const term = terminal(p.root, [() => { fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("title: Weekly rotation", "title: Daily rotation")); return "all"; }, "P-001 P-002"]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(1);
    expect(term.err.join("\n") + term.out.join("\n")).toContain("DECISION_CONFIRM_PREVIEW_CHANGED");
    expect(term.asked).toHaveLength(1);
    expect(decisions()).toEqual([]);
  });

  it("two proposals that supersede the same Decision cannot be confirmed in one session", async () => {
    await propose(1);
    expect(await run(["decision", "review-pending"], terminal(p.root, ["P-001", "P-001"]).io)).toBe(0);
    const s = createDecisionService({ root: p.root });
    await s.propose(agent, { title: "Biweekly rotation", question: "rotation_period", answer: "biweekly", supersedes: "D-001" });
    await s.propose(agent, { title: "Monthly rotation", question: "rotation_period", answer: "monthly", supersedes: "D-001" });
    const term = terminal(p.root, ["all", "P-002 P-003"]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(1);
    expect(term.out.join("\n") + term.err.join("\n")).toContain("DECISION_SESSION_CONFLICT");
    expect(term.asked).toHaveLength(1);
    expect(decisions()).toEqual(["D-001.yaml"]);
    // One of them alone is fine: it supersedes D-001.
    expect(await run(["decision", "review-pending"], terminal(p.root, ["P-002", "P-002"]).io)).toBe(0);
    expect(loadProjectTruth(p.root).value?.truth.decisions.map((d) => [d.id, d.state])).toEqual([["D-001", "superseded"], ["D-002", "confirmed"]]);
  });

  it("one by one: confirm, skip, stop; a later proposal shows what changed before its prompt", async () => {
    await propose(3);
    const term = terminal(p.root, ["one", "P-001", "skip", ""]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(0);
    expect(term.err.join("\n")).toContain("P-002 changed since the review above");
    expect(decisions()).toEqual(["D-001.yaml"]);
    expect(pending()).toEqual(["P-002.yaml", "P-003.yaml"]);
    expect(term.out.join("\n")).toContain("Stopped");
  });

  it("partial Truth: no preview, no prompt, nothing confirmed", async () => {
    await propose(1);
    expect(await run(["decision", "review-pending"], terminal(p.root, ["P-001", "P-001"]).io)).toBe(0);
    await propose(1);
    fs.appendFileSync(path.join(dir(), "D-001.yaml"), "future_rule: 1\n");
    const term = terminal(p.root, ["all", "P-001"]);
    expect(await run(["decision", "review-pending"], term.io)).toBe(1);
    expect(term.err.join("\n") + term.out.join("\n")).toContain("PROJECT_TRUTH_INVALID");
    expect(term.asked).toEqual([]);
  });

  it("the single confirm is unchanged", async () => {
    await propose(2);
    expect(await run(["decision", "confirm", "P-002"], terminal(p.root, ["P-002"]).io)).toBe(0);
    expect(decisions()).toEqual(["D-001.yaml"]);
    expect(pending()).toEqual(["P-001.yaml"]);
  });
});
