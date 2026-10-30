/**
 * Issue #33 ([AGT-01]): Decision continuity across sessions and agents (No-LLM Oracle & Handoff Harness).
 *
 * Verifies that when Session 1 (Agent A) finishes work and Session 2 (Agent B) starts fresh
 * with zero conversational memory on a follow-up task in the same governed area:
 *   1. Both CLI (`projectContext`) and MCP (`MCP_TOOLS.duo_get_context`) deliver a ready ContextPacket
 *      containing the active confirmed Decision(s) in `decisions.active` with graph evidence (`via`).
 *   2. Superseded Decisions never leak into `decisions.active` and are isolated in `decisions.history`
 *      with `state: "superseded"` and `supersededBy` pointing to the active replacement.
 *   3. Unconfirmed proposals (`P-*`) never leak into `decisions.active` and are isolated in
 *      `pendingDecisions` with `confirmed: false` and `status: "PENDING / NOT CONFIRMED"`.
 *   4. Deterministic review (`projectReview`) passes Session 2 compliant edits (`PASS`) and blocks
 *      Session 2 edits that violate the active confirmed Decision (`BLOCK` citing the Decision ID).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultAnalyzerRegistry } from "@duo-director/analyzer";
import { createDecisionService } from "@duo-director/core";
import { indexRepository, openProjectGraphStore } from "@duo-director/graph";
import {
  LLMProviderPool,
  MCP_TOOLS,
  projectContext,
  projectReview,
} from "@duo-director/integration";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "duo-continuity-test",
  GIT_AUTHOR_EMAIL: "continuity@example.invalid",
  GIT_COMMITTER_NAME: "duo-continuity-test",
  GIT_COMMITTER_EMAIL: "continuity@example.invalid",
  GIT_AUTHOR_DATE: "2026-04-19T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-04-19T00:00:00Z",
};

function gitExec(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    windowsHide: true,
  });
}

function writeFiles(root, fileMap) {
  for (const [relPath, content] of Object.entries(fileMap)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }
}

let cachedRegistry;
async function getRegistry() {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const registryResult = await createDefaultAnalyzerRegistry();
  if (!registryResult.value) {
    throw new Error(`createDefaultAnalyzerRegistry failed: ${JSON.stringify(registryResult.diagnostics)}`);
  }
  cachedRegistry = registryResult.value;
  return cachedRegistry;
}

async function runFullIndex(root) {
  const registry = await getRegistry();
  const opened = openProjectGraphStore(root);
  if (opened.value === undefined) {
    throw new Error(`openProjectGraphStore failed: ${JSON.stringify(opened.diagnostics)}`);
  }
  try {
    const indexed = await indexRepository(root, {
      store: opened.value,
      registry,
    });
    if (indexed.value === undefined) {
      throw new Error(`indexRepository failed: ${JSON.stringify(indexed.diagnostics)}`);
    }
    return indexed.value;
  } finally {
    opened.value.close();
  }
}

/**
 * Verify that a Session 2 ContextPacket satisfies all Decision Continuity invariants.
 *
 * @param {object | undefined} packet - The `ContextPacket` returned to Session 2.
 * @param {object} expected
 * @param {string[]} expected.activeIds - Confirmed Decision IDs that MUST be in `decisions.active`.
 * @param {string[]} [expected.forbiddenActiveIds] - Decision/Proposal IDs that MUST NOT be in `decisions.active`.
 * @param {Array<{ id: string, supersededBy: string }>} [expected.supersededHistory] - Superseded Decisions expected in `decisions.history`.
 * @param {Array<{ id: string, requiresHumanDecision?: boolean }>} [expected.pendingProposals] - Unconfirmed Proposals expected in `pendingDecisions`.
 */
export function verifyHandoffContextPacket(packet, expected) {
  const violations = [];
  if (!packet || packet.format !== "duo.context-packet/1") {
    return {
      ok: false,
      violations: ["ContextPacket is missing or has an invalid format"],
      activeIds: [],
      historyIds: [],
      pendingIds: [],
    };
  }

  const activeItems = Array.isArray(packet.decisions?.active) ? packet.decisions.active : [];
  const historyItems = Array.isArray(packet.decisions?.history) ? packet.decisions.history : [];
  const pendingItems = Array.isArray(packet.pendingDecisions) ? packet.pendingDecisions : [];

  const activeIds = activeItems.map((item) => item.ref);
  const historyIds = historyItems.map((item) => item.id);
  const pendingIds = pendingItems.map((item) => item.id);

  // 1. Required active confirmed Decisions must be present with non-empty whyIncluded evidence
  for (const reqId of expected.activeIds ?? []) {
    const found = activeItems.find((item) => item.ref === reqId);
    if (!found) {
      violations.push(`Expected confirmed Decision ${reqId} in decisions.active, but got [${activeIds.join(", ")}]`);
      continue;
    }
    if (found.state !== "confirmed") {
      violations.push(`Active Decision ${reqId} must have state="confirmed", got "${String(found.state)}"`);
    }
    if (!found.via || typeof found.via.seed !== "string" || found.via.seed.trim() === "") {
      violations.push(`Active Decision ${reqId} is missing provenance seed (via.seed)`);
    }
  }

  // 2. Forbidden IDs (superseded decisions or unconfirmed proposals) must NEVER appear in decisions.active
  for (const forbiddenId of expected.forbiddenActiveIds ?? []) {
    if (activeIds.includes(forbiddenId)) {
      violations.push(`Forbidden or non-active ID ${forbiddenId} leaked into decisions.active`);
    }
  }

  // 3. Superseded Decisions must be isolated in decisions.history with supersededBy link
  for (const sup of expected.supersededHistory ?? []) {
    const entry = historyItems.find((h) => h.id === sup.id);
    if (!entry) {
      violations.push(`Expected superseded Decision ${sup.id} in decisions.history, but got [${historyIds.join(", ")}]`);
      continue;
    }
    if (entry.state !== "superseded") {
      violations.push(`History Decision ${sup.id} must have state="superseded", got "${String(entry.state)}"`);
    }
    if (entry.supersededBy !== sup.supersededBy) {
      violations.push(
        `History Decision ${sup.id} must have supersededBy="${sup.supersededBy}", got "${String(entry.supersededBy)}"`,
      );
    }
  }

  // 4. Unconfirmed proposals must be isolated in pendingDecisions with PENDING / NOT CONFIRMED status
  for (const pend of expected.pendingProposals ?? []) {
    const entry = pendingItems.find((p) => p.id === pend.id);
    if (!entry) {
      violations.push(`Expected unconfirmed Proposal ${pend.id} in pendingDecisions, but got [${pendingIds.join(", ")}]`);
      continue;
    }
    if (entry.confirmed !== false) {
      violations.push(`Pending item ${pend.id} must have confirmed=false, got ${String(entry.confirmed)}`);
    }
    if (entry.status !== "PENDING / NOT CONFIRMED") {
      violations.push(
        `Pending item ${pend.id} must have status="PENDING / NOT CONFIRMED", got "${String(entry.status)}"`,
      );
    }
    if (
      pend.requiresHumanDecision !== undefined &&
      entry.requiresHumanDecision !== pend.requiresHumanDecision
    ) {
      violations.push(
        `Pending item ${pend.id} expected requiresHumanDecision=${String(pend.requiresHumanDecision)}, got ${String(entry.requiresHumanDecision)}`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    activeIds,
    historyIds,
    pendingIds,
  };
}

/**
 * Evaluate a complete 2-session handoff scenario against the Decision Continuity Oracle.
 *
 * @param {object} input
 * @param {string} input.scenarioId
 * @param {string} input.description
 * @param {object} input.cliContextOp - Result of `projectContext` in Session 2
 * @param {object} input.mcpContextOp - Result of `MCP_TOOLS.duo_get_context.run` in Session 2
 * @param {object} input.expectedPacket - Expected active/history/pending Decision invariants
 * @param {object} input.compliantReviewOp - Result of `projectReview` after Session 2 compliant edit
 * @param {object} input.violatingReviewOp - Result of `projectReview` after Session 2 violating edit
 * @param {string} input.expectedViolatedDecisionId - Decision ID that MUST block the violating edit
 */
export function evaluateHandoffScenario(input) {
  const violations = [];

  // 1. Verify CLI projectContext surface
  const cliStatus = input.cliContextOp?.kind === "ok" ? input.cliContextOp.payload?.status : undefined;
  const cliFreshness =
    input.cliContextOp?.kind === "ok" ? input.cliContextOp.payload?.context?.freshness?.status : undefined;
  const cliPacket = input.cliContextOp?.kind === "ok" ? input.cliContextOp.payload?.context?.packet : undefined;

  if (cliStatus !== "ready" || cliFreshness !== "current") {
    violations.push(
      `Session 2 CLI projectContext must return status="ready" and freshness.status="current" (got status="${String(cliStatus)}", freshness="${String(cliFreshness)}")`,
    );
  }
  const cliCheck = verifyHandoffContextPacket(cliPacket, input.expectedPacket);
  for (const v of cliCheck.violations) {
    violations.push(`CLI ContextPacket: ${v}`);
  }

  // 2. Verify MCP duo_get_context surface
  const mcpStatus = input.mcpContextOp?.kind === "ok" ? input.mcpContextOp.payload?.status : undefined;
  const mcpFreshness =
    input.mcpContextOp?.kind === "ok" ? input.mcpContextOp.payload?.context?.freshness?.status : undefined;
  const mcpPacket = input.mcpContextOp?.kind === "ok" ? input.mcpContextOp.payload?.context?.packet : undefined;

  if (mcpStatus !== "ready" || mcpFreshness !== "current") {
    violations.push(
      `Session 2 MCP duo_get_context must return status="ready" and freshness.status="current" (got status="${String(mcpStatus)}", freshness="${String(mcpFreshness)}")`,
    );
  }
  const mcpCheck = verifyHandoffContextPacket(mcpPacket, input.expectedPacket);
  for (const v of mcpCheck.violations) {
    violations.push(`MCP ContextPacket: ${v}`);
  }

  // 3. Verify CLI <-> MCP surface parity
  if (JSON.stringify(cliCheck.activeIds) !== JSON.stringify(mcpCheck.activeIds)) {
    violations.push(
      `CLI and MCP active Decision IDs diverged: CLI=[${cliCheck.activeIds.join(", ")}] vs MCP=[${mcpCheck.activeIds.join(", ")}]`,
    );
  }
  if (JSON.stringify(cliCheck.historyIds) !== JSON.stringify(mcpCheck.historyIds)) {
    violations.push(
      `CLI and MCP history Decision IDs diverged: CLI=[${cliCheck.historyIds.join(", ")}] vs MCP=[${mcpCheck.historyIds.join(", ")}]`,
    );
  }
  if (JSON.stringify(cliCheck.pendingIds) !== JSON.stringify(mcpCheck.pendingIds)) {
    violations.push(
      `CLI and MCP pending Decision IDs diverged: CLI=[${cliCheck.pendingIds.join(", ")}] vs MCP=[${mcpCheck.pendingIds.join(", ")}]`,
    );
  }

  // 4. Verify Session 2 compliant edit is never blocked and receives the expected non-blocking verdict (PASS, or ASK when a pending proposal requires human confirmation)
  const allowedCompliantVerdicts = input.expectedCompliantVerdicts ?? ["PASS"];
  const compliantVerdict =
    input.compliantReviewOp?.kind === "ok" ? input.compliantReviewOp.payload?.verdict : undefined;
  const compliantFreshness =
    input.compliantReviewOp?.kind === "ok" ? input.compliantReviewOp.payload?.freshness?.status : undefined;
  const compliantClaims =
    input.compliantReviewOp?.kind === "ok" ? (input.compliantReviewOp.payload?.claims ?? []) : [];
  const compliantBlockingClaims = compliantClaims.filter(
    (claim) => claim.alignment === "CONFLICT" && claim.blockEligible === true,
  );

  if (!allowedCompliantVerdicts.includes(compliantVerdict) || compliantFreshness !== "current") {
    violations.push(
      `Session 2 compliant edit must receive verdict in [${allowedCompliantVerdicts.join(", ")}] and freshness.status="current" (got verdict="${String(compliantVerdict)}", freshness="${String(compliantFreshness)}")`,
    );
  }
  if (compliantBlockingClaims.length > 0) {
    violations.push(
      `Session 2 compliant edit must have 0 blocking claims, but got ${compliantBlockingClaims.length}`,
    );
  }

  // 5. Verify Session 2 violating edit is blocked by the expected Decision ID
  const violatingVerdict =
    input.violatingReviewOp?.kind === "ok" ? input.violatingReviewOp.payload?.verdict : undefined;
  const violatingFreshness =
    input.violatingReviewOp?.kind === "ok" ? input.violatingReviewOp.payload?.freshness?.status : undefined;
  const violatingClaims =
    input.violatingReviewOp?.kind === "ok" ? (input.violatingReviewOp.payload?.claims ?? []) : [];

  if (violatingVerdict !== "BLOCK" || violatingFreshness !== "current") {
    violations.push(
      `Session 2 violating edit must receive verdict="BLOCK" and freshness.status="current" (got verdict="${String(violatingVerdict)}", freshness="${String(violatingFreshness)}")`,
    );
  }

  const citedDecision = violatingClaims.some(
    (claim) =>
      claim.alignment === "CONFLICT" &&
      claim.blockEligible === true &&
      (claim.subject?.id === input.expectedViolatedDecisionId ||
        String(claim.reason ?? "").includes(input.expectedViolatedDecisionId)),
  );
  if (!citedDecision) {
    violations.push(
      `Session 2 violating edit BLOCK claims did not cite expected Decision ${input.expectedViolatedDecisionId}`,
    );
  }

  return {
    scenarioId: input.scenarioId,
    description: input.description,
    classification: violations.length === 0 ? "continuity-verified" : "continuity-broken",
    activeIds: cliCheck.activeIds,
    historyIds: cliCheck.historyIds,
    pendingIds: cliCheck.pendingIds,
    compliantVerdict: compliantVerdict ?? "ERROR",
    violatingVerdict: violatingVerdict ?? "ERROR",
    citedDecisionId: citedDecision ? input.expectedViolatedDecisionId : null,
    violations,
  };
}

/**
 * Create the base billing repository fixture before Session 1 starts.
 */
function createBaseBillingRepo(root) {
  gitExec(root, ["-c", "init.defaultBranch=main", "init", "-q"]);
  gitExec(root, ["config", "core.autocrlf", "false"]);

  writeFiles(root, {
    ".gitignore": ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n",
    "package.json": JSON.stringify(
      {
        name: "duo-continuity-billing-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
    ".duo-project/project.yaml": [
      "schema_version: 1",
      "name: duo-continuity-billing-fixture",
      "",
    ].join("\n"),
    ".duo-project/specs/billing.md": [
      "# Billing",
      "",
      "## BILLING-01 Billing operations use approved payment gateway",
      "",
      "```duo",
      "status: in_progress",
      "```",
      "",
      "Invoice, checkout, and refund operations under `src/billing/` must process payments safely.",
      "",
    ].join("\n"),
    "src/legacy/payment.ts": [
      "export function chargeLegacy(amount: number): string {",
      '  return `legacy:${amount}`;',
      "}",
      "",
    ].join("\n"),
    "src/legacy/payment-v1.ts": [
      "export function chargeV1(amount: number): string {",
      '  return `v1:${amount}`;',
      "}",
      "",
    ].join("\n"),
    "src/adapters/payment-gateway.ts": [
      "// @duo BILLING-01",
      "export function chargeGateway(amount: number): string {",
      '  return `gateway:${amount}`;',
      "}",
      "",
    ].join("\n"),
    "src/adapters/payment-v2.ts": [
      "// @duo BILLING-01",
      "export function chargeV2(amount: number): string {",
      '  return `v2:${amount}`;',
      "}",
      "",
    ].join("\n"),
    "src/billing/invoice.ts": [
      "// @duo BILLING-01",
      'import { chargeGateway } from "../adapters/payment-gateway.js";',
      "",
      "export function createInvoice(amount: number): string {",
      "  return chargeGateway(amount);",
      "}",
      "",
    ].join("\n"),
    "src/billing/refund.ts": [
      "// @duo BILLING-01",
      'import { chargeGateway } from "../adapters/payment-gateway.js";',
      "",
      "export function processRefund(amount: number): string {",
      "  return chargeGateway(-amount);",
      "}",
      "",
    ].join("\n"),
    "src/billing/checkout.ts": [
      "// @duo BILLING-01",
      'import { chargeV2 } from "../adapters/payment-v2.js";',
      "",
      "export function runCheckout(amount: number): string {",
      "  return chargeV2(amount);",
      "}",
      "",
    ].join("\n"),
  });

  gitExec(root, ["add", "-A"]);
  gitExec(root, ["commit", "-qm", "Initial billing repository fixture"]);
}

/**
 * Helper to query Session 2 context via both CLI (`projectContext`) and MCP (`duo_get_context`).
 */
async function querySession2Context(root, task, agentName = "claude-session-2") {
  const cliContextOp = await projectContext(root, { task });
  const mcpRun = await MCP_TOOLS.duo_get_context.run(
    { task },
    {
      root,
      agentName,
      duoSessionId: "session-2-handoff",
      signal: new AbortController().signal,
      llm: new LLMProviderPool(),
    },
  );
  return {
    cliContextOp,
    mcpContextOp: mcpRun.op,
  };
}

/**
 * Scenario H1: Confirmed Forbidden-Import Decision (`D-001`) Continuity Across Session Handoff.
 *
 * - Session 1 (Codex): Proposes and human confirms `D-001` forbidding `src/legacy/payment.ts` imports
 *   in `src/billing/**`. Session 1 updates `src/billing/invoice.ts`, commits, and indexes.
 * - Session 2 (Claude Code, fresh session): Requests context for `BILLING-01 src/billing/refund.ts`.
 *   Verifies `D-001` is in `decisions.active`, compliant edit to `refund.ts` passes review, and
 *   violating edit importing `src/legacy/payment.ts` is blocked citing `D-001`.
 */
export async function runScenarioH1ForbiddenImportHandoff() {
  const startedAt = performance.now();
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-continuity-h1-")));
  try {
    createBaseBillingRepo(tmpRoot);
    const decisionService = createDecisionService({ root: tmpRoot });

    // --- Session 1 (Agent A: codex-session-1 + human confirmation) ---
    const prop1 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Billing modules must use payment-gateway adapter instead of legacy payment",
        question: "How should billing modules invoke payment processing?",
        answer: "Import src/adapters/payment-gateway.ts and never import src/legacy/payment.ts.",
        rationale: "Direct legacy payment calls bypass audit and retry guards.",
        governs: {
          requirements: ["BILLING-01"],
          paths: ["src/billing/**"],
        },
        forbids: {
          imported_paths: ["src/legacy/payment.ts"],
        },
        enforcement: "block",
      },
    );
    if (prop1.value === undefined) {
      throw new Error(`H1 propose failed: ${JSON.stringify(prop1.diagnostics)}`);
    }

    const conf1 = await decisionService.confirm(
      { kind: "human", name: "billing-maintainer" },
      prop1.value.proposalId,
    );
    if (conf1.value === undefined) {
      throw new Error(`H1 confirm failed: ${JSON.stringify(conf1.diagnostics)}`);
    }

    // Session 1 completes work on invoice.ts, commits, and indexes before ending session
    writeFiles(tmpRoot, {
      "src/billing/invoice.ts": [
        "// @duo BILLING-01",
        'import { chargeGateway } from "../adapters/payment-gateway.js";',
        "",
        "export function createInvoice(amount: number): string {",
        '  return `invoice:${chargeGateway(amount)}`;',
        "}",
        "",
      ].join("\n"),
    });
    gitExec(tmpRoot, ["add", "-A"]);
    gitExec(tmpRoot, ["commit", "-qm", "Session 1: confirm D-001 and update invoice.ts"]);
    await runFullIndex(tmpRoot);

    // --- Session 2 (Agent B: claude-session-2 starts with zero memory) ---
    const task = "BILLING-01 update refund handling in src/billing/refund.ts";
    const { cliContextOp, mcpContextOp } = await querySession2Context(tmpRoot, task);

    // Session 2 attempt A: Compliant edit to src/billing/refund.ts
    writeFiles(tmpRoot, {
      "src/billing/refund.ts": [
        "// @duo BILLING-01",
        'import { chargeGateway } from "../adapters/payment-gateway.js";',
        "",
        "export function processRefund(amount: number): string {",
        '  return `refund:${chargeGateway(-Math.abs(amount))}`;',
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const compliantReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    // Session 2 attempt B: Violating edit to src/billing/refund.ts (imports forbidden src/legacy/payment.ts)
    writeFiles(tmpRoot, {
      "src/billing/refund.ts": [
        "// @duo BILLING-01",
        'import { chargeLegacy } from "../legacy/payment.js";',
        "",
        "export function processRefund(amount: number): string {",
        "  return chargeLegacy(-Math.abs(amount));",
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const violatingReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    const evaluation = evaluateHandoffScenario({
      scenarioId: "H1",
      description: "Confirmed forbidden-import Decision (D-001) continuity from Session 1 to Session 2",
      cliContextOp,
      mcpContextOp,
      expectedPacket: {
        activeIds: ["D-001"],
        forbiddenActiveIds: ["P-001"],
        supersededHistory: [],
        pendingProposals: [],
      },
      compliantReviewOp,
      violatingReviewOp,
      expectedViolatedDecisionId: "D-001",
    });

    return {
      ...evaluation,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario H2: Superseded Decision (`D-001` -> `D-002`) Continuity Across Session Handoff.
 *
 * - Session 1: Initial Decision `D-001` forbade `src/legacy/payment.ts`. Later in Session 1,
 *   architecture evolved: `D-002` supersedes `D-001` and forbids `src/legacy/payment-v1.ts`
 *   in favor of `src/adapters/payment-v2.ts`. Session 1 commits and indexes.
 * - Session 2 (fresh session): Requests context for `BILLING-01 src/billing/checkout.ts`.
 *   Verifies that ONLY `D-002` is in `decisions.active`, while `D-001` is isolated in
 *   `decisions.history` (`state: "superseded"`, `supersededBy: "D-002"`), and that following
 *   the obsolete v1 pattern is blocked by `D-002`.
 */
export async function runScenarioH2SupersededDecisionHandoff() {
  const startedAt = performance.now();
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-continuity-h2-")));
  try {
    createBaseBillingRepo(tmpRoot);
    const decisionService = createDecisionService({ root: tmpRoot });

    // Step 1: Initial Decision D-001 confirmed
    const prop1 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Use payment-v1 instead of raw legacy payment",
        question: "Which payment client should billing modules use?",
        answer: "Use payment-v1 or v2 adapters; do not import src/legacy/payment.ts.",
        governs: {
          requirements: ["BILLING-01"],
          paths: ["src/billing/**"],
        },
        forbids: {
          imported_paths: ["src/legacy/payment.ts"],
        },
        enforcement: "block",
      },
    );
    if (prop1.value === undefined) {
      throw new Error(`H2 prop1 failed: ${JSON.stringify(prop1.diagnostics)}`);
    }
    const conf1 = await decisionService.confirm(
      { kind: "human", name: "billing-maintainer" },
      prop1.value.proposalId,
    );
    if (conf1.value === undefined) {
      throw new Error(`H2 conf1 failed: ${JSON.stringify(conf1.diagnostics)}`);
    }

    // Step 2: Session 1 supersedes D-001 with D-002 (forbidding payment-v1.ts as well)
    const prop2 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Migrate all billing modules to payment-v2 and forbid payment-v1",
        question: "Which payment client should billing modules use?",
        answer: "Use src/adapters/payment-v2.ts; importing src/legacy/payment-v1.ts is now forbidden.",
        rationale: "payment-v1 lacks idempotency keys required for checkout.",
        supersedes: "D-001",
        governs: {
          requirements: ["BILLING-01"],
          paths: ["src/billing/**"],
        },
        forbids: {
          imported_paths: ["src/legacy/payment-v1.ts"],
        },
        enforcement: "block",
      },
    );
    if (prop2.value === undefined) {
      throw new Error(`H2 prop2 failed: ${JSON.stringify(prop2.diagnostics)}`);
    }
    const conf2 = await decisionService.confirm(
      { kind: "human", name: "billing-maintainer" },
      prop2.value.proposalId,
    );
    if (conf2.value === undefined) {
      throw new Error(`H2 conf2 failed: ${JSON.stringify(conf2.diagnostics)}`);
    }

    gitExec(tmpRoot, ["add", "-A"]);
    gitExec(tmpRoot, ["commit", "-qm", "Session 1: supersede D-001 with D-002"]);
    await runFullIndex(tmpRoot);

    // --- Session 2 (Agent B: claude-session-2 starts fresh) ---
    // Mention D-001 in task or query BILLING-01 so both D-001 (superseded) and D-002 (active) are traversed
    const task = "BILLING-01 D-001 update checkout flow in src/billing/checkout.ts";
    const { cliContextOp, mcpContextOp } = await querySession2Context(tmpRoot, task);

    // Session 2 attempt A: Compliant edit using payment-v2.ts (satisfies D-002)
    writeFiles(tmpRoot, {
      "src/billing/checkout.ts": [
        "// @duo BILLING-01",
        'import { chargeV2 } from "../adapters/payment-v2.js";',
        "",
        "export function runCheckout(amount: number): string {",
        '  return `checkout:${chargeV2(amount)}`;',
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const compliantReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    // Session 2 attempt B: Violating edit using obsolete payment-v1.ts (violates active D-002)
    writeFiles(tmpRoot, {
      "src/billing/checkout.ts": [
        "// @duo BILLING-01",
        'import { chargeV1 } from "../legacy/payment-v1.js";',
        "",
        "export function runCheckout(amount: number): string {",
        "  return chargeV1(amount);",
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const violatingReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    const evaluation = evaluateHandoffScenario({
      scenarioId: "H2",
      description: "Superseded Decision (D-001 -> D-002) isolation in history and enforcement of active D-002",
      cliContextOp,
      mcpContextOp,
      expectedPacket: {
        activeIds: ["D-002"],
        forbiddenActiveIds: ["D-001"],
        supersededHistory: [{ id: "D-001", supersededBy: "D-002" }],
        pendingProposals: [],
      },
      compliantReviewOp,
      violatingReviewOp,
      expectedViolatedDecisionId: "D-002",
    });

    return {
      ...evaluation,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario H3: Unconfirmed Proposal (`P-002`) Isolation vs Confirmed Decision (`D-001`) Across Handoff.
 *
 * - Session 1: `D-001` is confirmed (`src/legacy/payment.ts` forbidden). Before ending Session 1,
 *   Agent A proposes a new Decision (`P-002`: forbidding symbol `*DraftAuditLogger*` and superseding `D-001`),
 *   but the human maintainer has NOT confirmed `P-002` yet.
 * - Session 2 (fresh session): Requests context for `BILLING-01 src/billing/refund.ts`.
 *   Verifies that `D-001` remains in `decisions.active`, while unconfirmed `P-002` is strictly isolated
 *   in `pendingDecisions` (`confirmed: false`, `status: "PENDING / NOT CONFIRMED"`, `requiresHumanDecision: true`).
 *   Also verifies that `projectReview` does NOT enforce unconfirmed `P-002`, while still blocking `D-001` violations.
 */
export async function runScenarioH3PendingProposalIsolationHandoff() {
  const startedAt = performance.now();
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-continuity-h3-")));
  try {
    createBaseBillingRepo(tmpRoot);
    const decisionService = createDecisionService({ root: tmpRoot });

    // Confirmed Decision D-001
    const prop1 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Billing modules must use payment-gateway adapter",
        question: "How should billing modules invoke payment processing?",
        answer: "Use src/adapters/payment-gateway.ts; never import src/legacy/payment.ts.",
        governs: {
          requirements: ["BILLING-01"],
          paths: ["src/billing/**"],
        },
        forbids: {
          imported_paths: ["src/legacy/payment.ts"],
        },
        enforcement: "block",
      },
    );
    if (prop1.value === undefined) {
      throw new Error(`H3 prop1 failed: ${JSON.stringify(prop1.diagnostics)}`);
    }
    const conf1 = await decisionService.confirm(
      { kind: "human", name: "billing-maintainer" },
      prop1.value.proposalId,
    );
    if (conf1.value === undefined) {
      throw new Error(`H3 conf1 failed: ${JSON.stringify(conf1.diagnostics)}`);
    }

    // Session 1 agent leaves an UNCONFIRMED proposal P-002 touching the same requirement/decision scope
    const prop2 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Forbid DraftAuditLogger helper symbols in billing modules",
        question: "Should DraftAuditLogger helpers be forbidden in billing?",
        answer: "Forbid any symbol matching *DraftAuditLogger* in billing modules.",
        supersedes: "D-001",
        governs: {
          requirements: ["BILLING-01"],
          paths: ["src/billing/**"],
        },
        forbids: {
          imported_paths: ["src/legacy/payment.ts"],
          symbols: ["*DraftAuditLogger*"],
        },
        enforcement: "block",
      },
    );
    if (prop2.value === undefined) {
      throw new Error(`H3 prop2 failed: ${JSON.stringify(prop2.diagnostics)}`);
    }
    const pendingProposalId = prop2.value.proposalId;

    gitExec(tmpRoot, ["add", "-A"]);
    gitExec(tmpRoot, ["commit", "-qm", "Session 1: confirm D-001 and leave unconfirmed proposal"]);
    await runFullIndex(tmpRoot);

    // --- Session 2 (Agent B: claude-session-2 starts fresh) ---
    const task = "BILLING-01 update refund handling in src/billing/refund.ts";
    const { cliContextOp, mcpContextOp } = await querySession2Context(tmpRoot, task);

    // Session 2 attempt A: Compliant with confirmed D-001, even if it defines `runDraftAuditLogger`
    // (proving unconfirmed P-002 is NOT treated as an active blocking rule)
    writeFiles(tmpRoot, {
      "src/billing/refund.ts": [
        "// @duo BILLING-01",
        'import { chargeGateway } from "../adapters/payment-gateway.js";',
        "",
        "export function runDraftAuditLogger(msg: string): string {",
        "  return msg;",
        "}",
        "",
        "export function processRefund(amount: number): string {",
        "  return runDraftAuditLogger(chargeGateway(-Math.abs(amount)));",
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const compliantReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    // Session 2 attempt B: Violates confirmed D-001 by importing src/legacy/payment.ts
    writeFiles(tmpRoot, {
      "src/billing/refund.ts": [
        "// @duo BILLING-01",
        'import { chargeLegacy } from "../legacy/payment.js";',
        "",
        "export function processRefund(amount: number): string {",
        "  return chargeLegacy(-Math.abs(amount));",
        "}",
        "",
      ].join("\n"),
    });
    await runFullIndex(tmpRoot);
    const violatingReviewOp = await projectReview(tmpRoot, {
      task,
      diff: { from: "HEAD", to: "WORKTREE" },
    });

    const evaluation = evaluateHandoffScenario({
      scenarioId: "H3",
      description:
        "Unconfirmed proposal (P-002) isolated in pendingDecisions (triggers ASK, never BLOCK) while confirmed D-001 stays active and enforced",
      cliContextOp,
      mcpContextOp,
      expectedPacket: {
        activeIds: ["D-001"],
        forbiddenActiveIds: [pendingProposalId],
        supersededHistory: [],
        pendingProposals: [{ id: pendingProposalId, requiresHumanDecision: true }],
      },
      expectedCompliantVerdicts: ["ASK"],
      compliantReviewOp,
      violatingReviewOp,
      expectedViolatedDecisionId: "D-001",
    });

    return {
      ...evaluation,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DUOCTL_BIN = path.join(REPO_ROOT, "apps/cli/dist/bin.js");

/**
 * Execute the real `duoctl` CLI binary (`apps/cli/dist/bin.js`) in a child process and parse its `--json` envelope.
 */
export function runDuoctlCli(root, args) {
  const proc = spawnSync(process.execPath, [DUOCTL_BIN, ...args, "--root", root, "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", DUO_LOCALE: "en" },
  });
  let envelope;
  try {
    envelope = JSON.parse(proc.stdout);
  } catch {
    envelope = null;
  }
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout,
    stderr: proc.stderr,
    envelope,
  };
}

export async function runAllContinuityScenarios() {
  const results = [];
  results.push(await runScenarioH1ForbiddenImportHandoff());
  results.push(await runScenarioH2SupersededDecisionHandoff());
  results.push(await runScenarioH3PendingProposalIsolationHandoff());
  return results;
}

/**
 * Verify end-to-end Session 2 handoff using the real `duoctl` CLI binary (`apps/cli/dist/bin.js`) subprocess:
 *   1. `duoctl index --json` builds the graph index.
 *   2. `duoctl context "<task>" --json` returns `D-001` in `decisions.active` and `P-002` in `pendingDecisions`.
 *   3. `duoctl decision confirm P-002 --non-interactive --json` is refused with `CLI_TTY_REQUIRED` (agent cannot self-confirm).
 *   4. `duoctl review --task "<task>" --json` blocks (`BLOCK`) a `D-001` violation with exit code `3` (`EXIT.BLOCK`).
 */
export async function verifyDuoctlCliSubprocessHandoff() {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-continuity-cli-")));
  try {
    createBaseBillingRepo(tmpRoot);
    const decisionService = createDecisionService({ root: tmpRoot });

    // Session 1 confirms D-001 and leaves unconfirmed P-002
    const prop1 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Billing modules must use payment-gateway adapter",
        question: "How should billing modules invoke payment processing?",
        answer: "Use src/adapters/payment-gateway.ts; never import src/legacy/payment.ts.",
        governs: { requirements: ["BILLING-01"], paths: ["src/billing/**"] },
        forbids: { imported_paths: ["src/legacy/payment.ts"] },
        enforcement: "block",
      },
    );
    await decisionService.confirm({ kind: "human", name: "billing-maintainer" }, prop1.value.proposalId);

    const prop2 = await decisionService.propose(
      { kind: "agent", name: "codex-session-1" },
      {
        title: "Forbid DraftAuditLogger helper symbols in billing modules",
        question: "Should DraftAuditLogger helpers be forbidden in billing?",
        answer: "Forbid any symbol matching *DraftAuditLogger* in billing modules.",
        supersedes: "D-001",
        governs: { requirements: ["BILLING-01"], paths: ["src/billing/**"] },
        forbids: { imported_paths: ["src/legacy/payment.ts"], symbols: ["*DraftAuditLogger*"] },
        enforcement: "block",
      },
    );
    const pendingId = prop2.value.proposalId;

    gitExec(tmpRoot, ["add", "-A"]);
    gitExec(tmpRoot, ["commit", "-qm", "Session 1: confirm D-001 and propose P-002"]);

    // 1. Run `duoctl index --json` via CLI subprocess
    const indexRun = runDuoctlCli(tmpRoot, ["index"]);
    const indexOk = indexRun.status === 0 && indexRun.envelope?.ok === true;

    // 2. Run `duoctl context "<task>" --json` via CLI subprocess
    const task = "BILLING-01 update refund handling in src/billing/refund.ts";
    const contextRun = runDuoctlCli(tmpRoot, ["context", task]);
    const packet = contextRun.envelope?.result?.context?.packet;
    const packetCheck = verifyHandoffContextPacket(packet, {
      activeIds: ["D-001"],
      forbiddenActiveIds: [pendingId],
      supersededHistory: [],
      pendingProposals: [{ id: pendingId, requiresHumanDecision: true }],
    });

    // 3. Verify Session 2 agent cannot self-confirm P-002 via non-interactive `duoctl decision confirm`
    const confirmAttempt = runDuoctlCli(tmpRoot, ["decision", "confirm", pendingId, "--non-interactive"]);
    const confirmGuardCodes = (confirmAttempt.envelope?.diagnostics ?? []).map((d) => d.code);
    const ttyGuardBlocked =
      confirmAttempt.status !== 0 && confirmGuardCodes.includes("CLI_TTY_REQUIRED");

    // 4. Write violating edit and run `duoctl index` + `duoctl review` via CLI subprocess
    writeFiles(tmpRoot, {
      "src/billing/refund.ts": [
        "// @duo BILLING-01",
        'import { chargeLegacy } from "../legacy/payment.js";',
        "",
        "export function processRefund(amount: number): string {",
        "  return chargeLegacy(-Math.abs(amount));",
        "}",
        "",
      ].join("\n"),
    });
    runDuoctlCli(tmpRoot, ["index"]);
    const reviewRun = runDuoctlCli(tmpRoot, ["review", "--task", task]);
    const reviewResult = reviewRun.envelope?.result;
    const reviewBlocked =
      reviewResult?.verdict === "BLOCK" &&
      Array.isArray(reviewResult?.claims) &&
      reviewResult.claims.some((c) => c.alignment === "CONFLICT" && c.subject?.id === "D-001");

    return {
      ok: indexOk && packetCheck.ok && ttyGuardBlocked && reviewBlocked,
      indexOk,
      packetCheck,
      ttyGuardBlocked,
      confirmGuardCodes,
      reviewVerdict: reviewResult?.verdict ?? "ERROR",
      reviewExitCode: reviewRun.status,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
