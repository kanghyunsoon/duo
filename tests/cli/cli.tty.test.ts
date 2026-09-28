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
    expect(baseline).toMatchObject({ format: "duo.adoption-baseline/1", workingTree: { dirty: true, policy: "HEAD_BASELINE", untracked: [{ path: "src/holidays.ts" }] }, recorded: { by: "Ada Lovelace" } });
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
