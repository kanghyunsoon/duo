import fs from "node:fs";
import path from "node:path";
import { createDecisionService, loadProjectTruth } from "@duo-director/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../../apps/cli/src/cli.js";
import { existingProject } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

/** A terminal that answers prompts from a script and records what was asked. */
function terminal(root: string, answers: string[], tty = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const io: Io = {
    out: (l) => out.push(l), err: (l) => err.push(l), isTTY: tty,
    prompt: (q) => { asked.push(q); return Promise.resolve(answers.shift()); },
    readStdin: () => Promise.resolve(""), cwd: () => root, now: () => new Date("2026-09-28T00:00:00Z"), env: {},
  };
  return { io, out, err, asked };
}

describe("interactive duoctl init (T15, terminal)", () => {
  it("asks only the Truth questions; an accepted suggestion keeps its provenance", async () => {
    const p = existingProject(temps);
    const term = terminal(p.root, ["y", "Launch weekly rotations", "No cloud sync; Durations are whole minutes", ""]);
    expect(await run(["init"], term.io)).toBe(0);
    expect(term.asked.map((q) => q.split("?")[0]?.split(":")[0])).toEqual([
      "Use the suggestion", "Current milestone or MVP scope (title, empty to skip)", "Critical constraints, separated by ';' (empty to skip)", "Create 5 files in .duo-project",
    ]);
    const truth = loadProjectTruth(p.root).value?.truth;
    expect(truth?.vision).toMatchObject({ status: "confirmed", sources: [{ kind: "external", path: "README.md" }] });
    expect(truth?.config.currentMilestone).toBe("M1");
    expect(truth?.constraints.map((c) => c.statement)).toEqual(["No cloud sync", "Durations are whole minutes"]);
    expect(term.out.join("\n")).toContain("Baseline");
  });

  it("--yes approves operations only: no Truth question is asked or answered", async () => {
    const p = existingProject(temps);
    const term = terminal(p.root, []);
    expect(await run(["init", "--yes"], term.io)).toBe(0);
    expect(term.asked).toEqual([]);
    const truth = loadProjectTruth(p.root).value?.truth;
    expect(truth?.vision?.status).toBe("draft");
    expect(truth?.gaps.map((g) => g.key)).toEqual(["project_goal", "current_milestone", "critical_constraints"]);
  });

  it("a dirty tree asks for the adoption policy (never taken from --yes); choosing HEAD captures a dirty-at-adoption baseline", async () => {
    const p = existingProject(temps);
    p.write("src/holidays.ts", "export const HOLIDAYS = [];\n");
    const term = terminal(p.root, ["1"]);
    expect(await run(["init", "--yes", "--locale", "ko"], term.io)).toBe(0);
    expect(term.asked).toEqual(["> "]);
    expect(term.out.join("\n")).toContain("작업 트리에 변경이 있습니다");
    const files = fs.readdirSync(path.join(p.root, ".duo-project", "reviews"));
    const baseline = JSON.parse(fs.readFileSync(path.join(p.root, ".duo-project", "reviews", files[0] ?? ""), "utf8"));
    expect(baseline).toMatchObject({ format: "duo.adoption-baseline/2", workingTree: { dirty: true, policy: "HEAD_BASELINE", untracked: [{ path: "src/holidays.ts" }] }, recorded: { by: "Ada Lovelace" } });
  });
});

describe("duoctl decision (T15, terminal)", () => {
  it("confirm needs a terminal and the ID typed again; it uses the DecisionService and the proposal read model", async () => {
    const p = existingProject(temps);
    expect(await run(["init", "--yes", "--non-interactive"], terminal(p.root, [], false).io)).toBe(0);
    const service = createDecisionService({ root: p.root });
    expect((await service.propose({ kind: "agent", name: "codex" }, { title: "Weekly rotation", question: "rotation_period", answer: "weekly" })).value?.proposalId).toBe("P-001");
    expect((await service.propose({ kind: "agent", name: "codex" }, { title: "Reminder channel", question: "reminder_channel", answer: "email" })).value?.proposalId).toBe("P-002");

    const list = terminal(p.root, []);
    expect(await run(["decision", "list", "--json"], list.io)).toBe(0);
    expect(JSON.parse(list.out[0] ?? "").result.pending.map((x: { id: string }) => x.id)).toEqual(["P-001", "P-002"]);

    const noTty = terminal(p.root, [], false);
    expect(await run(["decision", "confirm", "P-001"], noTty.io)).toBe(1);
    expect(noTty.err.join("\n")).toContain("interactive terminal");
    expect(await run(["decision", "confirm", "P-001", "--non-interactive"], terminal(p.root, ["P-001"]).io)).toBe(1);

    const wrong = terminal(p.root, ["P-002"]);
    expect(await run(["decision", "confirm", "P-001"], wrong.io)).toBe(1);
    expect(fs.existsSync(path.join(p.root, ".duo-project", "decisions", "D-001.yaml"))).toBe(false);

    const ok = terminal(p.root, ["P-001"]);
    expect(await run(["decision", "confirm", "P-001"], ok.io)).toBe(0);
    expect(ok.out.join("\n")).toContain("D-001");
    const decision = fs.readFileSync(path.join(p.root, ".duo-project", "decisions", "D-001.yaml"), "utf8");
    expect(decision).toContain("confirmed_by: Ada Lovelace");

    const rej = terminal(p.root, ["P-002"]);
    expect(await run(["decision", "reject", "P-002", "--reason", "not now"], rej.io)).toBe(0);
    const after = terminal(p.root, []);
    await run(["decision", "list", "--json"], after.io);
    expect(JSON.parse(after.out[0] ?? "").result.pending).toEqual([]); // committed and rejected proposals are not pending
  });
});
describe("informed confirm (T34.2, terminal)", () => {
  /** A terminal whose prompt runs a callback first (to change files between the preview and the typed ID). */
  function scripted(root: string, answer: string, beforeAnswer: () => void = () => undefined) {
    const err: string[] = [];
    const out: string[] = [];
    let shownBeforePrompt: string[] = [];
    const io: Io = {
      out: (l) => out.push(l), err: (l) => err.push(l), isTTY: true,
      prompt: () => { shownBeforePrompt = [...err]; beforeAnswer(); return Promise.resolve(answer); },
      readStdin: () => Promise.resolve(""), cwd: () => root, now: () => new Date("2026-10-05T00:00:00Z"), env: {},
    };
    return { io, err, out, before: () => shownBeforePrompt.join("\n") };
  }

  it("shows the whole candidate before the ID is typed, binds the confirm to it, and aborts if it changed", async () => {
    const p = existingProject(temps);
    expect(await run(["init", "--yes", "--non-interactive"], terminal(p.root, [], false).io)).toBe(0);
    const service = createDecisionService({ root: p.root });
    const codex = { kind: "agent" as const, name: "codex" };
    await service.propose(codex, { title: "Weekly rotation", question: "rotation_period", answer: "weekly" });

    // A minimal proposal: absent fields are shown as absent, the expected ID is an expectation.
    const first = scripted(p.root, "P-001");
    expect(await run(["decision", "confirm", "P-001"], first.io)).toBe(0);
    const shown = first.before();
    expect(shown).toContain("Confirm P-001: this proposal becomes a new confirmed Decision.");
    for (const label of ["Title", "Question", "Answer", "Kind", "Rationale", "Governs", "Forbids", "Enforcement", "Supersedes", "Stale", "Expected ID"]) expect(shown).toContain(`  ${label}`);
    expect(shown).toMatch(/Forbids +\(not set\)/u);
    expect(shown).toMatch(/Enforcement +\(not set\)/u);
    expect(shown).toMatch(/Stale +no$/mu);
    expect(shown).toMatch(/Proposed by +codex \(agent\)/u);
    expect(shown).toMatch(/Expected ID +D-001 \(expected; the ID in the confirm result is authoritative\)/u);
    expect(first.out.join("\n")).toContain("confirmed as D-001");
    expect(first.out.join("\n")).toContain("Run duoctl index so review and context see it.");

    // forbids, enforcement, the superseded target and staleness, all before the guard (a human proposal through the core API).
    const human = { kind: "human" as const, name: "Ada Lovelace" };
    await service.propose(human, { title: "Daily rotation", question: "rotation_period", answer: "daily", forbids: { symbols: ["*WeeklyRotation*"] }, enforcement: "block", supersedes: "D-001", governs: { paths: ["src/**"] } });
    p.write(".duo-project/decisions/D-001.yaml", fs.readFileSync(path.join(p.root, ".duo-project/decisions/D-001.yaml"), "utf8") + "# reviewed again\n");
    const second = scripted(p.root, "P-002");
    expect(await run(["decision", "confirm", "P-002"], second.io)).toBe(0);
    const s = second.before();
    expect(s).toMatch(/Forbids +symbols: \*WeeklyRotation\*/u);
    expect(s).toMatch(/Enforcement +block/u);
    expect(s).toMatch(/Governs +paths: src\/\*\*/u);
    expect(s).toMatch(/Supersedes +D-001 "Weekly rotation" \(confirmed\) → becomes superseded by this Decision/u);
    expect(s).toMatch(/Stale +yes, Project Truth changed since this proposal was made/u);
    expect(s).toMatch(/Expected ID +D-002 \(expected/u);
    expect(s).toMatch(/Proposed by +Ada Lovelace \(human\)/u);
    expect(loadProjectTruth(p.root).value?.truth.decisions.find((d) => d.id === "D-001")?.state).toBe("superseded");

    // The candidate changes while the ID is being typed: nothing is confirmed.
    await service.propose(codex, { title: "Reminder channel", question: "reminder_channel", answer: "email" });
    const proposal = path.join(p.root, ".duo-project/decisions/proposals/P-003.yaml");
    const changed = scripted(p.root, "P-003", () => fs.writeFileSync(proposal, fs.readFileSync(proposal, "utf8").replace("answer: email", "answer: sms")));
    expect(await run(["decision", "confirm", "P-003"], changed.io)).toBe(1);
    expect(changed.err.join("\n")).toContain("The Decision changed after you reviewed it. Review the current contents and confirm again.");
    expect(fs.existsSync(path.join(p.root, ".duo-project/decisions/D-003.yaml"))).toBe(false);
    expect(fs.existsSync(proposal)).toBe(true);

    // Reject shows the proposal's contents before the guard; its meaning is unchanged.
    const rej = scripted(p.root, "P-003");
    expect(await run(["decision", "reject", "P-003", "--reason", "not now"], rej.io)).toBe(0);
    expect(rej.before()).toContain("Reject P-003: the proposal is kept as rejected; nothing becomes a Decision.");
    expect(rej.before()).toMatch(/Answer +sms/u);
    expect(rej.before()).not.toContain("Expected ID");
    expect(loadProjectTruth(p.root).value?.truth.proposals.find((x) => x.id === "P-003")?.state).toBe("rejected");

    // A missing or no longer pending candidate fails before the guard; a Decision ID still gets the service's refusal for reject.
    const gone = scripted(p.root, "P-003");
    expect(await run(["decision", "confirm", "P-003"], gone.io)).toBe(1);
    expect(gone.before()).toBe("");
    const locked = scripted(p.root, "D-002");
    expect(await run(["decision", "reject", "D-002"], locked.io)).toBe(1);
    expect(locked.err.join("\n")).toContain("DECISION_LOCKED");

    // A YAML Decision has no staleness model: "not applicable", never "no" (T34.3).
    p.write(".duo-project/decisions/D-009.yaml", "id: D-009\ntitle: Minutes only\nkind: decision\nstate: proposed\nquestion: duration_unit\nanswer: minutes\n");
    const inPlace = scripted(p.root, "D-009");
    expect(await run(["decision", "confirm", "D-009"], inPlace.io)).toBe(0);
    expect(inPlace.before()).toMatch(/Stale +not applicable \(staleness is tracked for proposals only\)/u);
    expect(inPlace.before()).toMatch(/Expected ID +D-009 \(confirmed in place\)/u);
    expect(inPlace.before()).not.toContain("Proposed by");
  });
});

