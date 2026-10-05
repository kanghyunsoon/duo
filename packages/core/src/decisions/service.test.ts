import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadProjectTruth } from "../loader/project.js";
import { DECISION_LOCK_PATH, guardDecisionWrite, nodeDecisionFileSystem, type DecisionActor, type DecisionFileSystem } from "./files.js";
import { listDecisionProposals, pendingDecisionProposals, repairDecisionState } from "./read-model.js";
import { createDecisionService, type DecisionService } from "./service.js";

const temps: string[] = [];
afterAll(() => temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })));

const human: DecisionActor = { kind: "human", name: "kanghyunsoon" };
const agent: DecisionActor = { kind: "agent", name: "codex" };
const system: DecisionActor = { kind: "system", name: "duo" };
const clock = () => new Date("2026-09-27T00:00:00.000Z");

let root: string;
const abs = (p: string) => path.join(root, p);
const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  fs.writeFileSync(abs(p), text);
};
const read = (p: string) => fs.readFileSync(abs(p), "utf8");
const exists = (p: string) => fs.existsSync(abs(p));
const truth = () => {
  const loaded = loadProjectTruth(root);
  if (loaded.value === undefined) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.value;
};
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);
const service = (options: Partial<Parameters<typeof createDecisionService>[0]> = {}): DecisionService => createDecisionService({ root, clock, ...options });
const input = { title: "Passkey login", question: "login_mechanism", answer: "passkey", governs: { requirements: ["AUTH-01"] } };

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-decisions-")));
  temps.push(root);
  write(".duo-project/project.yaml", "schema_version: 1\nname: decisions\n");
  write(".duo-project/specs/auth.md", "# Auth\n\n## AUTH-01 Login\n\n```duo\nstatus: planned\n```\n\nUsers log in.\n");
  // A Human-owned Decision with a comment, confirmed and locked through the service (ADR-013 in-place confirm).
  write(".duo-project/decisions/D-001.yaml", "# Chosen in the kickoff meeting\nid: D-001\ntitle: Password login\nkind: decision\nstate: proposed\nquestion: login_mechanism\nanswer: password\ngoverns:\n  requirements: [AUTH-01]\nenforcement: warn\n");
  const r = await service().confirm(human, "D-001");
  expect(r.diagnostics).toEqual([]);
});

describe("TASK-009 DecisionService: AI may propose, a human confirms", () => {
  it("AC-009-01 an agent proposal creates one new file under decisions/proposals/ and nothing else", async () => {
    const before = fs.readdirSync(abs(".duo-project"), { recursive: true }).map(String).sort();
    const d001 = read(".duo-project/decisions/D-001.yaml");
    const r = await service().propose(agent, input);
    expect(r.value).toMatchObject({ proposalId: "P-001", path: ".duo-project/decisions/proposals/P-001.yaml", indexRequired: false });
    const after = fs.readdirSync(abs(".duo-project"), { recursive: true }).map(String).sort().filter((f) => !f.includes("runtime"));
    expect(after.filter((f) => !before.includes(f)).map((f) => f.replace(/\\/g, "/"))).toEqual(["decisions/proposals", "decisions/proposals/P-001.yaml"].filter((f) => !before.map((b) => b.replace(/\\/g, "/")).includes(f)));
    expect(read(".duo-project/decisions/D-001.yaml")).toBe(d001);
    const p = truth().truth.proposals.find((x) => x.id === "P-001");
    expect(p).toMatchObject({ state: "proposed", proposedBy: "codex", proposedByKind: "agent", proposedAt: "2026-09-27T00:00:00.000Z" });
    expect(p?.basedOn?.truthDigest).toMatch(/^sha256:/);
    expect(p?.basedOn?.refs.map((x) => x.id)).toEqual(["AUTH-01"]);
    expect(truth().truth.decisions.map((d) => d.id)).toEqual(["D-001"]);
    expect(exists(DECISION_LOCK_PATH)).toBe(false);
  });

  it("agents and the system may propose but never confirm or reject", async () => {
    expect((await service().propose(system, input)).value?.proposalId).toBe("P-001");
    for (const actor of [agent, system]) {
      expect(codes(await service().confirm(actor, "P-001"))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
      expect(codes(await service().reject(actor, "P-001"))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
    }
    expect(codes(await service().confirm({ kind: "robot" as never, name: "x" }, "P-001"))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
    expect(truth().truth.proposals[0]?.state).toBe("proposed");
  });

  it("AC-009-02 a human confirm allocates D-###, records the audit fields and a valid lock; the Graph is not touched", async () => {
    await service().propose(agent, input);
    const r = await service().confirm(human, "P-001");
    expect(r.value).toMatchObject({ decisionId: "D-002", path: ".duo-project/decisions/D-002.yaml", from: "P-001", indexRequired: true });
    expect(exists(".duo-project/decisions/proposals/P-001.yaml")).toBe(false);
    const d = truth().truth.decisions.find((x) => x.id === "D-002");
    expect(d).toMatchObject({
      state: "confirmed", owner: "human", proposalId: "P-001", proposedBy: "codex", proposedByKind: "agent",
      confirmedBy: "kanghyunsoon", confirmedAt: "2026-09-27T00:00:00.000Z", title: "Passkey login",
    });
    expect(service().verifyLock("D-002").value?.status).toBe("valid");
    expect(service().verifyLock("D-001").value?.status).toBe("valid");
    expect(read(".duo-project/decisions/D-001.yaml")).toContain("# Chosen in the kickoff meeting");
  });

  it("AC-009-04 a human reject keeps the proposal with state, time, actor and reason", async () => {
    await service().propose(agent, input);
    const r = await service().reject(human, "P-001", "Passkeys are out of scope for M1");
    expect(r.value).toMatchObject({ proposalId: "P-001", indexRequired: false });
    const p = truth().truth.proposals.find((x) => x.id === "P-001");
    expect(p).toMatchObject({ state: "rejected", rejectedBy: "kanghyunsoon", rejectedAt: "2026-09-27T00:00:00.000Z", reason: "Passkeys are out of scope for M1" });
    expect(codes(await service().reject(human, "P-001"))).toEqual(["PROPOSAL_NOT_PENDING"]);
    expect(codes(await service().confirm(human, "P-001"))).toEqual(["PROPOSAL_NOT_PENDING"]);
    expect(truth().truth.decisions.map((d) => d.id)).toEqual(["D-001"]);
  });

  it("a confirmed Decision is not modified through the service", async () => {
    const before = read(".duo-project/decisions/D-001.yaml");
    expect(codes(await service().confirm(human, "D-001"))).toEqual(["DECISION_LOCKED"]);
    expect(codes(await service().reject(human, "D-001"))).toEqual(["DECISION_LOCKED"]);
    expect(read(".duo-project/decisions/D-001.yaml")).toBe(before);
    // An agent cannot write a Decision file at all, whatever the operation.
    expect(codes(guardDecisionWrite(root, agent, ".duo-project/decisions/D-001.yaml", "decision"))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
  });

  it("AC-009-03 supersede: a new Decision, the old one only changes state and superseded_by and keeps a valid lock", async () => {
    const before = truth().truth.decisions.find((d) => d.id === "D-001");
    await service().propose(agent, { ...input, supersedes: "D-001" });
    const r = await service().confirm(human, "P-001");
    expect(r.value).toMatchObject({ decisionId: "D-002", supersedes: "D-001" });
    const loaded = truth();
    const old = loaded.truth.decisions.find((d) => d.id === "D-001");
    expect(old).toMatchObject({ state: "superseded", supersededBy: "D-002" });
    expect({ ...old, state: undefined, supersededBy: undefined, location: undefined, references: undefined })
      .toEqual({ ...before, state: undefined, supersededBy: undefined, location: undefined, references: undefined });
    expect(service().verifyLock("D-001").value?.status).toBe("valid");
    expect(read(".duo-project/decisions/D-001.yaml")).toContain("# Chosen in the kickoff meeting");
    expect(loaded.trace.links.some((l) => l.relation === "SUPERSEDES" && l.from.id === "D-002" && l.to.id === "D-001")).toBe(true);
  });

  it("refuses self-supersede, a cycle, a missing target and a target that is not confirmed", async () => {
    write(".duo-project/decisions/D-005.yaml", "id: D-005\ntitle: Self\nstate: proposed\nquestion: q5\nanswer: a\nsupersedes: D-005\n");
    expect(codes(await service().confirm(human, "D-005"))).toContain("DECISION_SUPERSEDES_SELF");
    write(".duo-project/decisions/D-010.yaml", "id: D-010\ntitle: Ten\nstate: confirmed\nquestion: q10\nanswer: a\nsupersedes: D-011\n");
    write(".duo-project/decisions/D-011.yaml", "id: D-011\ntitle: Eleven\nstate: proposed\nquestion: q11\nanswer: b\nsupersedes: D-010\n");
    const d011 = read(".duo-project/decisions/D-011.yaml");
    expect(codes(await service().confirm(human, "D-011"))).toContain("DECISION_SUPERSEDE_CYCLE");
    expect(read(".duo-project/decisions/D-011.yaml")).toBe(d011);
    const missing = await service().propose(agent, { ...input, supersedes: "D-999" });
    expect(codes(missing)).toEqual(["PROPOSAL_INVALID", "BROKEN_REFERENCE"]);
    expect(exists(".duo-project/decisions/proposals")).toBe(false);
    expect(codes(await service().propose(agent, { ...input, supersedes: "D-005" }))).toEqual(["PROPOSAL_INVALID", "DECISION_SUPERSEDE_TARGET_INVALID"]);
  });

  it("two concurrent confirms get different IDs; one proposal is never confirmed twice", async () => {
    await service().propose(agent, input);
    await service().propose(agent, { ...input, title: "Magic links", answer: "magic-link" });
    const [a, b] = await Promise.all([service().confirm(human, "P-001"), service().confirm(human, "P-002")]);
    expect([a.value?.decisionId, b.value?.decisionId].sort()).toEqual(["D-002", "D-003"]);
    await service().propose(agent, { ...input, title: "OTP", answer: "otp" });
    const twice = await Promise.all([service().confirm(human, "P-003"), service().confirm(human, "P-003")]);
    expect(twice.map((r) => r.value?.decisionId ?? codes(r).join())).toEqual(expect.arrayContaining(["D-004", "PROPOSAL_NOT_PENDING"]));
    expect(truth().truth.decisions.filter((d) => d.proposalId === "P-003")).toHaveLength(1);
  });

  it("another writer that ignores the lock cannot make two Decisions share an ID", async () => {
    await service().propose(agent, input);
    let raced = false;
    const racing: DecisionFileSystem = {
      ...nodeDecisionFileSystem,
      async createExclusive(file, text) {
        if (!raced && file.endsWith(`D-002.yaml`)) {
          raced = true;
          fs.writeFileSync(file, "id: D-002\ntitle: Foreign\nstate: proposed\nquestion: qf\nanswer: f\n"); // lands between allocation and create
        }
        return nodeDecisionFileSystem.createExclusive(file, text);
      },
    };
    const r = await service({ fs: racing }).confirm(human, "P-001");
    expect(r.value?.decisionId).toBe("D-003");
    expect(read(".duo-project/decisions/D-002.yaml")).toContain("Foreign");
  });

  it("waits for the repository lock, gives up when it stays held and breaks a dead process's lock", async () => {
    write(DECISION_LOCK_PATH, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    expect(codes(await service({ lockTimeoutMs: 100 }).propose(agent, input))).toEqual(["DECISION_LOCK_BUSY"]);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    write(DECISION_LOCK_PATH, JSON.stringify({ pid: dead, host: os.hostname() }));
    expect((await service({ lockTimeoutMs: 100 }).propose(agent, input)).value?.proposalId).toBe("P-001");
    expect(exists(DECISION_LOCK_PATH)).toBe(false);
  });

  it("a failed write before the commit changes nothing; after the commit the next operation finishes it", async () => {
    await service().propose(agent, { ...input, supersedes: "D-001" });
    const failingCreate: DecisionFileSystem = { ...nodeDecisionFileSystem, async createExclusive(file, text) {
      if (file.includes(`${path.sep}decisions${path.sep}D-`)) throw new Error("disk full");
      return nodeDecisionFileSystem.createExclusive(file, text);
    } };
    expect(codes(await service({ fs: failingCreate }).confirm(human, "P-001"))).toEqual(["FILE_WRITE_ERROR"]);
    expect(truth().truth.decisions.map((d) => d.id)).toEqual(["D-001"]);
    expect(truth().truth.proposals[0]?.state).toBe("proposed");

    const failingAfter: DecisionFileSystem = {
      ...nodeDecisionFileSystem,
      async remove(file) {
        if (file.includes("proposals")) throw new Error("file locked by an editor");
        return nodeDecisionFileSystem.remove(file);
      },
      async writeAtomic(file, text) {
        if (file.endsWith("D-001.yaml")) throw new Error("file locked by an editor");
        return nodeDecisionFileSystem.writeAtomic(file, text);
      },
    };
    const r = await service({ fs: failingAfter }).confirm(human, "P-001");
    expect(r.value?.decisionId).toBe("D-002");
    expect(codes(r)).toEqual(["FILE_WRITE_ERROR"]);
    expect(r.diagnostics[0]?.severity).toBe("warning");
    expect(exists(".duo-project/decisions/proposals/P-001.yaml")).toBe(true); // committed Decision, proposal not yet removed

    const repaired = await service().repair();
    expect(repaired.value?.repaired).toEqual(["removed .duo-project/decisions/proposals/P-001.yaml (confirmed as D-002)", "marked D-001 superseded by D-002"]);
    expect(exists(".duo-project/decisions/proposals/P-001.yaml")).toBe(false);
    expect(truth().truth.decisions.find((d) => d.id === "D-001")?.state).toBe("superseded");
    expect(codes(await service().confirm(human, "P-001"))).toEqual(["PROPOSAL_NOT_PENDING"]);
  });

  it("a stale proposal is confirmed with PROPOSAL_STALE and names what changed", async () => {
    await service().propose(agent, input);
    write(".duo-project/specs/auth.md", read(".duo-project/specs/auth.md").replace("Users log in.", "Users log in with SSO."));
    const r = await service().confirm(human, "P-001");
    expect(r.value).toMatchObject({ decisionId: "D-002", stale: { truthChanged: true, changedRefs: ["AUTH-01"] } });
    expect(codes(r)).toEqual(["PROPOSAL_STALE"]);
  });

  it("keeps every write inside the write boundary; IDs never become paths unchecked", async () => {
    expect(codes(await service().confirm(human, "../../etc/passwd"))).toEqual(["INVALID_ID"]);
    expect(codes(await service().reject(human, "P-001/../../x"))).toEqual(["INVALID_ID"]);
    expect(guardDecisionWrite(root, agent, ".duo-project/decisions/proposals/P-001.yaml", "proposal").value?.path).toBe(".duo-project/decisions/proposals/P-001.yaml");
    expect(codes(guardDecisionWrite(root, human, ".duo-project/decisions/proposals/../D-001.yaml", "proposal"))).toContain("WRITE_NOT_ALLOWED");
    expect(codes(guardDecisionWrite(root, human, "src/app.ts", "decision"))).toContain("WRITE_NOT_ALLOWED");
    expect(codes(guardDecisionWrite(root, human, "../outside/D-001.yaml", "decision"))).toContain("WRITE_OUTSIDE_REPOSITORY");
    expect(codes(guardDecisionWrite(root, human, ".duo-project/decisions/proposals/P-001.yaml", "decision"))).toContain("WRITE_NOT_ALLOWED");
    expect(codes(guardDecisionWrite(root, human, ".duo-project/runtime/other.lock", "lock"))).toContain("WRITE_NOT_ALLOWED");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "duo-outside-"));
    temps.push(outside);
    try {
      fs.symlinkSync(outside, abs(".duo-project/decisions/proposals"), "junction");
    } catch {
      return; // symlinks unavailable here (e.g. Windows without privilege)
    }
    expect(codes(await service().propose(agent, input))).toContain("WRITE_NOT_ALLOWED");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("AC-009-05 only confirm writes a confirmed state (static check)", () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "../../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!["node_modules", "dist"].includes(entry.name)) walk(p);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const text = fs.readFileSync(p, "utf8");
          if (/state\s*:\s*(?:"confirmed"|'confirmed'|CONFIRMED)/u.test(text)) offenders.push(path.relative(repo, p).replace(/\\/g, "/"));
        }
      }
    };
    for (const top of ["packages", "apps"]) walk(path.join(repo, top));
    // init/render.ts writes the critical Constraints a human gave during init as confirmed (T14): Constraints, not Decisions.
    expect(offenders).toEqual(["packages/core/src/decisions/service.ts", "packages/director/src/init/render.ts"]);
  });
});


describe("T09.1 proposal read model: pending is a logical state, reading never writes", () => {
  const snapshot = () => fs.readdirSync(abs(".duo-project"), { recursive: true }).map(String).sort()
    .map((f) => [f, fs.statSync(abs(`.duo-project/${f}`)).isFile() ? read(`.duo-project/${f}`) : "<dir>"]);

  it("pending, rejected and committed; a committed proposal file left behind is not pending; only explicit repair writes", async () => {
    await service().propose(agent, input);                                          // P-001 stays pending
    await service().propose(agent, { ...input, title: "Magic links", answer: "m" }); // P-002 is rejected
    await service().propose(agent, { ...input, title: "OTP", answer: "otp" });       // P-003 is committed, cleanup fails
    await service().reject(human, "P-002", "no");
    const failingRemove: DecisionFileSystem = { ...nodeDecisionFileSystem, async remove(file) {
      if (file.includes("proposals")) throw new Error("file locked by an editor");
      return nodeDecisionFileSystem.remove(file);
    } };
    expect((await service({ fs: failingRemove }).confirm(human, "P-003")).value?.decisionId).toBe("D-002");
    expect(exists(".duo-project/decisions/proposals/P-003.yaml")).toBe(true);

    const before = snapshot();
    const entries = listDecisionProposals(truth().truth);
    expect(entries.map((e) => [e.id, e.status, e.decisionId ?? null])).toEqual([
      ["P-001", "pending", null], ["P-002", "rejected", null], ["P-003", "committed", "D-002"],
    ]);
    expect(entries.find((e) => e.id === "P-003")?.cleanupPending).toBe(true);
    expect(pendingDecisionProposals(truth().truth).map((p) => p.id)).toEqual(["P-001"]);
    expect(snapshot()).toEqual(before); // reading wrote nothing and did not repair
    expect(exists(".duo-project/decisions/proposals/P-003.yaml")).toBe(true);

    expect((await repairDecisionState({ root, clock })).value?.repaired).toEqual(["removed .duo-project/decisions/proposals/P-003.yaml (confirmed as D-002)"]);
    expect(listDecisionProposals(truth().truth).map((e) => [e.id, e.status])).toEqual([["P-001", "pending"], ["P-002", "rejected"]]);
  });
});
describe("T34.2 informed confirm: the preview is the candidate confirm acts on", () => {
  const full = { ...input, kind: "decision" as const, rationale: "Phishing-resistant", forbids: { symbols: ["*SessionStore*"], paths: ["src/legacy/**"] }, enforcement: "block" as const, supersedes: "D-001" };

  it("A/F a proposal preview shows every content field, the superseded target and its consequence, and an expected (not guaranteed) ID", async () => {
    await service().propose(human, full);
    const p = (await service().previewConfirm("P-001")).value;
    expect(p).toMatchObject({
      sourceId: "P-001", sourceKind: "proposal", sourcePath: ".duo-project/decisions/proposals/P-001.yaml", action: "create", proposalId: "P-001",
      expectedDecisionId: "D-002", nextDecisionId: "D-002",
      candidate: { title: "Passkey login", kind: "decision", question: "login_mechanism", answer: "passkey", rationale: "Phishing-resistant", governs: { requirements: ["AUTH-01"] },
        forbids: { symbols: ["*SessionStore*"], paths: ["src/legacy/**"] }, enforcement: "block", supersedes: "D-001" },
      supersedes: { id: "D-001", title: "Password login", state: "confirmed", path: ".duo-project/decisions/D-001.yaml" },
    });
    expect(p?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(p?.stale).toBeUndefined();
  });

  it("an absent field stays absent: no default is invented", async () => {
    await service().propose(agent, input);
    const c = (await service().previewConfirm("P-001")).value?.candidate ?? {};
    expect(Object.keys(c).sort()).toEqual(["answer", "governs", "question", "title"]);
  });

  it("B a proposed D-### YAML Decision previews in place; a locked Decision is refused like confirm", async () => {
    write(".duo-project/decisions/D-002.yaml", "id: D-002\ntitle: No legacy store\nkind: decision\nstate: proposed\nquestion: session_store\nanswer: none\nforbids:\n  symbols: [\"*LegacyStore*\"]\nenforcement: block\n");
    const p = (await service().previewConfirm("D-002")).value;
    expect(p).toMatchObject({ sourceId: "D-002", sourceKind: "decision", action: "confirm-in-place", expectedDecisionId: "D-002",
      candidate: { title: "No legacy store", forbids: { symbols: ["*LegacyStore*"] }, enforcement: "block" } });
    expect(p?.proposalId).toBeUndefined();
    expect(codes(await service().previewConfirm("D-001"))).toEqual(["DECISION_LOCKED"]);
    expect(codes(await service().previewConfirm("../x"))).toEqual(["INVALID_ID"]);
  });

  it("G staleness is part of the preview, before anything is confirmed", async () => {
    await service().propose(agent, input);
    write(".duo-project/specs/auth.md", read(".duo-project/specs/auth.md").replace("Users log in.", "Users log in with SSO."));
    expect((await service().previewConfirm("P-001")).value?.stale).toEqual({ truthChanged: true, changedRefs: ["AUTH-01"] });
    expect(exists(".duo-project/decisions/D-002.yaml")).toBe(false);
  });

  it("K/N/O an unchanged candidate confirms with the preview digest; indexRequired and the lock are as before", async () => {
    await service().propose(human, full);
    const p = (await service().previewConfirm("P-001")).value;
    const r = await service().confirm(human, "P-001", { expectedDigest: p?.digest ?? "" });
    expect(r.value).toMatchObject({ decisionId: "D-002", supersedes: "D-001", indexRequired: true });
    expect(service().verifyLock("D-002").value?.status).toBe("valid");
    expect(service().verifyLock("D-001").value?.status).toBe("valid");
    expect(truth().truth.decisions.find((d) => d.id === "D-002")).toMatchObject({ forbids: { symbols: ["*SessionStore*"] }, enforcement: "block" });
  });

  it("L a candidate edited after the preview is not confirmed; nothing is written and the proposal stays pending", async () => {
    await service().propose(human, full);
    const p = (await service().previewConfirm("P-001")).value;
    write(".duo-project/decisions/proposals/P-001.yaml", read(".duo-project/decisions/proposals/P-001.yaml").replace("enforcement: block", "enforcement: warn"));
    const r = await service().confirm(human, "P-001", { expectedDigest: p?.digest ?? "" });
    expect(codes(r)).toEqual(["DECISION_CONFIRM_PREVIEW_CHANGED"]);
    expect(r.diagnostics[0]?.message).toBe("The Decision changed after you reviewed it. Review the current contents and confirm again.");
    expect(exists(".duo-project/decisions/D-002.yaml")).toBe(false);
    expect(truth().truth.decisions.find((d) => d.id === "D-001")?.state).toBe("confirmed");
    expect(pendingDecisionProposals(truth().truth).map((x) => x.id)).toEqual(["P-001"]);
    const again = (await service().previewConfirm("P-001")).value;
    expect(again?.candidate.enforcement).toBe("warn");
    expect((await service().confirm(human, "P-001", { expectedDigest: again?.digest ?? "" })).value?.decisionId).toBe("D-002");
  });

  it("M the superseded target changing after the preview (another confirm took it) aborts instead of a different failure", async () => {
    await service().propose(human, full);
    await service().propose(human, { ...full, title: "WebAuthn login", answer: "webauthn" });
    const p1 = (await service().previewConfirm("P-001")).value;
    expect((await service().confirm(human, "P-002")).value?.decisionId).toBe("D-002");
    expect(codes(await service().confirm(human, "P-001", { expectedDigest: p1?.digest ?? "" }))).toEqual(["DECISION_CONFIRM_PREVIEW_CHANGED"]);
    expect(codes(await service().previewConfirm("P-001"))).toEqual([]);
    expect((await service().previewConfirm("P-001")).value?.supersedes).toMatchObject({ id: "D-001", state: "superseded" });
  });

  it("H the expected ID is an expectation: if another Decision takes it, the confirm result's ID is the authority", async () => {
    // A proposal without based_on has no staleness, so an unrelated confirm does not change what was reviewed.
    write(".duo-project/decisions/proposals/P-001.yaml", "id: P-001\ntitle: Reports in cents\nstate: proposed\nquestion: report_unit\nanswer: whole cents\nproposed_by: kanghyunsoon\nproposed_by_kind: human\n");
    const p = (await service().previewConfirm("P-001")).value;
    expect(p?.expectedDecisionId).toBe("D-002");
    write(".duo-project/decisions/D-002.yaml", "id: D-002\ntitle: Other\nstate: proposed\nquestion: other\nanswer: x\n");
    expect((await service().confirm(human, "D-002")).value?.decisionId).toBe("D-002");
    const r = await service().confirm(human, "P-001", { expectedDigest: p?.digest ?? "" });
    expect(r.value?.decisionId).toBe("D-003");
  });

  it("P agents and the system still cannot confirm or reject, with or without a digest; previewing writes nothing", async () => {
    await service().propose(agent, input);
    const before = fs.readdirSync(abs(".duo-project/decisions/proposals"));
    const p = (await service().previewConfirm("P-001")).value;
    expect(fs.readdirSync(abs(".duo-project/decisions/proposals"))).toEqual(before);
    expect(exists(DECISION_LOCK_PATH)).toBe(false);
    expect(codes(await service().confirm(agent, "P-001", { expectedDigest: p?.digest ?? "" }))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
    expect(codes(await service().confirm(system, "P-001", { expectedDigest: p?.digest ?? "" }))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
    expect(codes(await service().reject(agent, "P-001"))).toEqual(["DECISION_ACTOR_FORBIDDEN"]);
  });
});

