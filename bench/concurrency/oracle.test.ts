/**
 * Issue #34 ([AGT-02]) Phase 2: Unit and integration verification for the concurrency oracle
 * (`bench/concurrency/oracle.mjs`) and Scenarios C1 (Decision proposals) & C2 (Graph indexing).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createDecisionService, DECISION_LOCK_PATH } from "@duo-director/core";
import {
  captureRepoSnapshot,
  createConcurrencyFixtureRepo,
  evaluateConcurrencyOracle,
  runScenarioConcurrentContextAndReview,
  runScenarioConcurrentDecisionProposals,
  runScenarioConcurrentGitWorktrees,
  runScenarioConcurrentGraphIndex,
  runScenarioConcurrentWorkMapActivity,
} from "./oracle.mjs";

function makeCleanSnapshot(overrides = {}) {
  return {
    truth: {
      ok: true,
      diagnostics: [],
      decisionIds: ["D-001"],
      decisionSignatures: ["Token session validation|confirmed|session_validation_strategy|signed_token|valid"],
      proposalIds: ["P-001", "P-002"],
      proposalSignatures: [
        "Proposal 1|proposed|q1|a1|agent:agent-1",
        "Proposal 2|proposed|q2|a2|agent:agent-2",
      ],
      ...(overrides.truth ?? {}),
    },
    graph: {
      exists: true,
      ok: true,
      dbToken: "token-123",
      stateToken: "token-123",
      tokenMatched: true,
      revision: "1",
      inspectionStatus: "fresh",
      invariantDiagnostics: [],
      dump: { nodes: ["node-a", "node-b"], edges: ["edge-1"] },
      ...(overrides.graph ?? {}),
    },
    workTasks: {
      count: 0,
      signatures: [],
      ...(overrides.workTasks ?? {}),
    },
    danglingLocks: overrides.danglingLocks ?? [],
    corruptedFiles: overrides.corruptedFiles ?? [],
  };
}

describe("Issue #34 Concurrency Oracle — 3-Tier Classification Rules", () => {
  it("classifies as 'safe' when all workers succeed and concurrent state equals sequential baseline", () => {
    const baseline = makeCleanSnapshot();
    const concurrent = makeCleanSnapshot();
    const result = evaluateConcurrencyOracle({
      scenario: "unit-safe",
      baselineSnapshot: baseline,
      concurrentSnapshot: concurrent,
      outcomes: [
        { ok: true, codes: [] },
        { ok: true, codes: [] },
      ],
    });

    assert.equal(result.classification, "safe");
    assert.equal(result.succeededCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.silentReasons, []);
    assert.equal(result.equivalence.proposalsEqual, true);
    assert.equal(result.equivalence.graphNodesEqual, true);
  });

  it("classifies as 'explicit-error' when contending workers fail with documented DUO codes and state stays valid", () => {
    const baseline = makeCleanSnapshot();
    const concurrent = makeCleanSnapshot();
    const result = evaluateConcurrencyOracle({
      scenario: "unit-explicit-error",
      baselineSnapshot: baseline,
      concurrentSnapshot: concurrent,
      outcomes: [
        { ok: true, codes: [] },
        { ok: false, codes: ["GRAPH_WRITE_REFUSED"], error: "BUSY: The graph changed" },
      ],
      checkTruthEquivalence: false,
      checkGraphEquivalence: true,
    });

    assert.equal(result.classification, "explicit-error");
    assert.equal(result.succeededCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.explicitErrorCodes, ["GRAPH_WRITE_REFUSED"]);
    assert.deepEqual(result.silentReasons, []);
  });

  it("classifies as 'silent-inconsistency' on lost update when all workers report ok but a proposal is missing", () => {
    const baseline = makeCleanSnapshot();
    const concurrent = makeCleanSnapshot({
      truth: {
        proposalIds: ["P-001"],
        proposalSignatures: ["Proposal 1|proposed|q1|a1|agent:agent-1"],
      },
    });
    const result = evaluateConcurrencyOracle({
      scenario: "unit-lost-update",
      baselineSnapshot: baseline,
      concurrentSnapshot: concurrent,
      outcomes: [
        { ok: true, codes: [] },
        { ok: true, codes: [] },
      ],
    });

    assert.equal(result.classification, "silent-inconsistency");
    assert.ok(result.silentReasons.some((r) => r.includes("Proposals differ from sequential baseline")));
  });

  it("classifies as 'silent-inconsistency' on index-state.json vs graph.sqlite token mismatch, corrupted files, or dangling locks", () => {
    const baseline = makeCleanSnapshot();
    const concurrent = makeCleanSnapshot({
      graph: {
        exists: true,
        ok: false,
        dbToken: "token-db-new",
        stateToken: "token-state-stale",
        tokenMatched: false,
        invariantDiagnostics: [],
        dump: { nodes: ["node-a", "node-b"], edges: ["edge-1"] },
      },
      danglingLocks: [".duo-project/runtime/locks/decisions.lock"],
      corruptedFiles: [{ path: ".duo-project/runtime/work-tasks.json", reason: "Unexpected end of JSON input" }],
    });

    const result = evaluateConcurrencyOracle({
      scenario: "unit-corruption-and-token-desync",
      baselineSnapshot: baseline,
      concurrentSnapshot: concurrent,
      outcomes: [{ ok: true, codes: [] }],
    });

    assert.equal(result.classification, "silent-inconsistency");
    assert.ok(result.silentReasons.some((r) => r.includes("Corrupted files detected")));
    assert.ok(result.silentReasons.some((r) => r.includes("Dangling lock/backup files")));
    assert.ok(result.silentReasons.some((r) => r.includes("does not match graph.sqlite token")));
  });
});

describe("Issue #34 Scenario C1 & C2 — Real Repository Concurrency Verification", () => {
  it("Scenario C1: 6 concurrent agent Decision proposals serialize safely and match sequential baseline", async () => {
    const report = await runScenarioConcurrentDecisionProposals({ workerCount: 6 });
    assert.equal(report.classification, "safe");
    assert.equal(report.succeededCount, 6);
    assert.equal(report.failedCount, 0);
    assert.deepEqual(report.silentReasons, []);
    assert.equal(report.equivalence.decisionsEqual, true);
    assert.equal(report.equivalence.proposalsEqual, true);
  });

  it("Scenario C1b: active lock contention exceeding lockTimeoutMs produces explicit DECISION_LOCK_BUSY without corruption", async () => {
    const seqRoot = createConcurrencyFixtureRepo("duo-c1b-seq-");
    const concRoot = createConcurrencyFixtureRepo("duo-c1b-conc-");
    const human = { kind: "human", name: "maintainer" };
    const clock = () => new Date("2026-10-27T00:00:00.000Z");

    try {
      await createDecisionService({ root: seqRoot, clock }).confirm(human, "D-001");
      await createDecisionService({ root: concRoot, clock }).confirm(human, "D-001");

      // Simulate an active local process holding decisions.lock during the short timeout window
      const lockFile = path.join(concRoot, DECISION_LOCK_PATH);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, host: "", startedAt: clock().toISOString() }),
        "utf8",
      );

      const outcomes = await Promise.all(
        Array.from({ length: 3 }, async (_, i) => {
          const service = createDecisionService({ root: concRoot, clock, lockTimeoutMs: 40 });
          const res = await service.propose(
            { kind: "agent", name: `agent-${i + 1}` },
            {
              title: `Blocked proposal ${i + 1}`,
              question: `blocked_q_${i + 1}`,
              answer: `blocked_a_${i + 1}`,
              governs: { requirements: ["AUTH-01"] },
            },
          );
          return {
            ok: res.value !== undefined && res.diagnostics.length === 0,
            codes: res.diagnostics.map((d) => d.code),
            error: res.diagnostics.map((d) => d.message).join("; "),
          };
        }),
      );

      // Release the simulated lock after the contending workers have timed out
      fs.rmSync(lockFile, { force: true });

      const report = evaluateConcurrencyOracle({
        scenario: "C1b:decision-lock-busy",
        baselineSnapshot: captureRepoSnapshot(seqRoot),
        concurrentSnapshot: captureRepoSnapshot(concRoot),
        outcomes,
        checkTruthEquivalence: true,
        checkGraphEquivalence: false,
      });

      assert.equal(report.classification, "explicit-error");
      assert.equal(report.succeededCount, 0);
      assert.equal(report.failedCount, 3);
      assert.deepEqual(report.explicitErrorCodes, ["DECISION_LOCK_BUSY"]);
      assert.deepEqual(report.silentReasons, []);
    } finally {
      fs.rmSync(seqRoot, { recursive: true, force: true });
      fs.rmSync(concRoot, { recursive: true, force: true });
    }
  });

  it("Scenario C2: 4 concurrent indexRepository runs preserve graph invariants and match sequential baseline", async () => {
    const coldReport = await runScenarioConcurrentGraphIndex({ workerCount: 4, preIndex: false });
    assert.notEqual(coldReport.classification, "silent-inconsistency", `Unexpected silent inconsistency: ${coldReport.silentReasons.join("; ")}`);
    assert.ok(coldReport.succeededCount >= 1);
    assert.deepEqual(coldReport.silentReasons, []);
    assert.equal(coldReport.equivalence.graphNodesEqual, true);
    assert.equal(coldReport.equivalence.graphEdgesEqual, true);

    const incrementalReport = await runScenarioConcurrentGraphIndex({ workerCount: 4, preIndex: true });
    assert.notEqual(
      incrementalReport.classification,
      "silent-inconsistency",
      `Unexpected silent inconsistency: ${incrementalReport.silentReasons.join("; ")}`,
    );
    assert.ok(incrementalReport.succeededCount >= 1);
    assert.deepEqual(incrementalReport.silentReasons, []);
    assert.equal(incrementalReport.equivalence.graphNodesEqual, true);
    assert.equal(incrementalReport.equivalence.graphEdgesEqual, true);
  });

  it("Scenario C3: 6 concurrent projectContext and projectReview runs match sequential baseline without graph corruption", async () => {
    const report = await runScenarioConcurrentContextAndReview({ workerCount: 6 });
    assert.equal(report.classification, "safe", `Unexpected issues: ${report.silentReasons.join("; ")}`);
    assert.equal(report.succeededCount, 6);
    assert.equal(report.failedCount, 0);
    assert.deepEqual(report.silentReasons, []);
    assert.equal(report.equivalence.graphNodesEqual, true);
    assert.equal(report.equivalence.graphEdgesEqual, true);
  });

  it("Scenario C4: 6 concurrent MCP sessions updating Work-Map activity serialize safely via work-tasks.lock", async () => {
    const report = await runScenarioConcurrentWorkMapActivity({ workerCount: 6 });
    assert.equal(report.classification, "safe", `Unexpected issues: ${report.silentReasons.join("; ")}`);
    assert.equal(report.succeededCount, 6);
    assert.equal(report.failedCount, 0);
    assert.deepEqual(report.silentReasons, []);
    assert.equal(report.equivalence.workTasksEqual, true);
  });

  it("Scenario C5: concurrent agents across separate Git worktrees isolate .duo-project state and match baseline", async () => {
    const report = await runScenarioConcurrentGitWorktrees();
    assert.equal(report.classification, "safe", `Unexpected issues: ${report.silentReasons.join("; ")}`);
    assert.equal(report.succeededCount, 2);
    assert.equal(report.failedCount, 0);
    assert.deepEqual(report.silentReasons, []);
    assert.equal(report.equivalence.decisionsEqual, true);
    assert.equal(report.equivalence.proposalsEqual, true);
    assert.equal(report.equivalence.graphNodesEqual, true);
    assert.equal(report.equivalence.graphEdgesEqual, true);
  });
});
