import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHandoffScenario,
  runScenarioH1ForbiddenImportHandoff,
  runScenarioH2SupersededDecisionHandoff,
  runScenarioH3PendingProposalIsolationHandoff,
  verifyDuoctlCliSubprocessHandoff,
  verifyHandoffContextPacket,
} from "./oracle.mjs";

function makeValidMockPacket() {
  return {
    format: "duo.context-packet/1",
    decisions: {
      active: [
        {
          id: "dec:D-002",
          ref: "D-002",
          kind: "decision",
          state: "confirmed",
          via: {
            seed: "BILLING-01",
            steps: [{ from: "BILLING-01", type: "GOVERNED_BY", to: "D-002", provenance: "declared" }],
          },
        },
      ],
      history: [
        {
          id: "D-001",
          title: "Legacy v1 rule",
          state: "superseded",
          supersededBy: "D-002",
        },
      ],
    },
    pendingDecisions: [
      {
        id: "P-003",
        kind: "proposal",
        title: "Draft audit rule",
        confirmed: false,
        status: "PENDING / NOT CONFIRMED",
        requiresHumanDecision: true,
        relatesTo: ["D-002", "BILLING-01"],
      },
    ],
  };
}

void test("verifyHandoffContextPacket accepts a valid Session 2 ContextPacket", () => {
  const packet = makeValidMockPacket();
  const result = verifyHandoffContextPacket(packet, {
    activeIds: ["D-002"],
    forbiddenActiveIds: ["D-001", "P-003"],
    supersededHistory: [{ id: "D-001", supersededBy: "D-002" }],
    pendingProposals: [{ id: "P-003", requiresHumanDecision: true }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.activeIds, ["D-002"]);
  assert.deepEqual(result.historyIds, ["D-001"]);
  assert.deepEqual(result.pendingIds, ["P-003"]);
});

void test("verifyHandoffContextPacket detects superseded or unconfirmed IDs leaking into decisions.active", () => {
  const packet = makeValidMockPacket();
  packet.decisions.active.push({
    id: "dec:D-001",
    ref: "D-001",
    kind: "decision",
    state: "superseded",
    via: { seed: "BILLING-01", steps: [] },
  });

  const result = verifyHandoffContextPacket(packet, {
    activeIds: ["D-002"],
    forbiddenActiveIds: ["D-001"],
    supersededHistory: [{ id: "D-001", supersededBy: "D-002" }],
    pendingProposals: [],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations.some((v) => v.includes("Forbidden or non-active ID D-001 leaked into decisions.active")),
    true,
  );
});

void test("verifyHandoffContextPacket detects corrupted supersededBy or confirmed pending proposal flags", () => {
  const packet = makeValidMockPacket();
  packet.decisions.history[0] = {
    id: "D-001",
    title: "Legacy v1 rule",
    state: "superseded",
    supersededBy: "D-999",
  };
  packet.pendingDecisions[0] = {
    ...packet.pendingDecisions[0],
    confirmed: true,
  };

  const result = verifyHandoffContextPacket(packet, {
    activeIds: ["D-002"],
    forbiddenActiveIds: ["D-001", "P-003"],
    supersededHistory: [{ id: "D-001", supersededBy: "D-002" }],
    pendingProposals: [{ id: "P-003", requiresHumanDecision: true }],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.violations.some((v) => v.includes('supersededBy="D-002"')),
    true,
  );
  assert.equal(
    result.violations.some((v) => v.includes("confirmed=false")),
    true,
  );
});

void test("evaluateHandoffScenario flags CLI/MCP divergence or missing BLOCK citation as continuity-broken", () => {
  const cliPacket = makeValidMockPacket();
  const mcpPacket = makeValidMockPacket();
  mcpPacket.decisions.active = [];

  const result = evaluateHandoffScenario({
    scenarioId: "H-MOCK",
    description: "Mock broken handoff",
    cliContextOp: {
      kind: "ok",
      payload: {
        status: "ready",
        context: { freshness: { status: "current" }, packet: cliPacket },
      },
    },
    mcpContextOp: {
      kind: "ok",
      payload: {
        status: "ready",
        context: { freshness: { status: "current" }, packet: mcpPacket },
      },
    },
    expectedPacket: {
      activeIds: ["D-002"],
      forbiddenActiveIds: ["D-001"],
      supersededHistory: [{ id: "D-001", supersededBy: "D-002" }],
      pendingProposals: [],
    },
    compliantReviewOp: {
      kind: "ok",
      payload: { verdict: "PASS", freshness: { status: "current" }, claims: [] },
    },
    violatingReviewOp: {
      kind: "ok",
      payload: { verdict: "PASS", freshness: { status: "current" }, claims: [] },
    },
    expectedViolatedDecisionId: "D-002",
  });

  assert.equal(result.classification, "continuity-broken");
  assert.equal(
    result.violations.some((v) => v.includes("CLI and MCP active Decision IDs diverged")),
    true,
  );
  assert.equal(
    result.violations.some((v) => v.includes('Session 2 violating edit must receive verdict="BLOCK"')),
    true,
  );
});

void test("Scenario H1: confirmed forbidden-import Decision (D-001) persists across Session 1 -> Session 2 handoff", async () => {
  const result = await runScenarioH1ForbiddenImportHandoff();
  assert.equal(result.classification, "continuity-verified", JSON.stringify(result.violations, null, 2));
  assert.deepEqual(result.activeIds, ["D-001"]);
  assert.equal(result.compliantVerdict, "PASS");
  assert.equal(result.violatingVerdict, "BLOCK");
  assert.equal(result.citedDecisionId, "D-001");
});

void test("Scenario H2: superseded Decision (D-001 -> D-002) isolates D-001 in history and enforces active D-002 in Session 2", async () => {
  const result = await runScenarioH2SupersededDecisionHandoff();
  assert.equal(result.classification, "continuity-verified", JSON.stringify(result.violations, null, 2));
  assert.deepEqual(result.activeIds, ["D-002"]);
  assert.deepEqual(result.historyIds, ["D-001"]);
  assert.equal(result.compliantVerdict, "PASS");
  assert.equal(result.violatingVerdict, "BLOCK");
  assert.equal(result.citedDecisionId, "D-002");
});

void test("Scenario H3: unconfirmed proposal (P-002) stays in pendingDecisions and is not enforced as active truth in Session 2", async () => {
  const result = await runScenarioH3PendingProposalIsolationHandoff();
  assert.equal(result.classification, "continuity-verified", JSON.stringify(result.violations, null, 2));
  assert.deepEqual(result.activeIds, ["D-001"]);
  assert.deepEqual(result.pendingIds, ["P-002"]);
  assert.equal(result.compliantVerdict, "ASK");
  assert.equal(result.violatingVerdict, "BLOCK");
  assert.equal(result.citedDecisionId, "D-001");
});

void test("duoctl CLI binary (apps/cli/dist/bin.js) enforces context, review, and non-TTY confirm guard across handoff", async () => {
  const result = await verifyDuoctlCliSubprocessHandoff();
  assert.equal(result.indexOk, true);
  assert.equal(result.packetCheck.ok, true, JSON.stringify(result.packetCheck.violations));
  assert.equal(result.ttyGuardBlocked, true);
  assert.equal(result.confirmGuardCodes.includes("CLI_TTY_REQUIRED"), true);
  assert.equal(result.reviewVerdict, "BLOCK");
});
