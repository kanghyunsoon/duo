# Decision Continuity Benchmark (`[AGT-01]` — Issue #33)

Deterministic No-LLM verification harness and Paid-Run Protocol Plan for evaluating **Decision continuity across sessions and agents** (`Session 1 Agent A → Session 2 Agent B`).

---

## 1. Ground-Truth Continuity Oracle (`oracle.mjs`)

When **Session 1 (Agent A)** finishes a task and exits, **Session 2 (Agent B)** starts a follow-up task in the same governed area with **zero conversational memory**. The oracle in [`oracle.mjs`](./oracle.mjs) evaluates two deterministic surfaces without any LLM calls:

1. **Session 2 Input Surface (`projectContext` & `MCP_TOOLS.duo_get_context`)**:
   - **Active Decisions (`packet.decisions.active`)**: Every active confirmed Decision governing the target requirement/path must be present with `state === "confirmed"` and a non-empty graph provenance seed (`via.seed`).
   - **Superseded Decision Isolation (`packet.decisions.history`)**: Any Decision superseded during or before Session 1 must **never** appear in `decisions.active`; it must be isolated in `decisions.history` with `state === "superseded"` and `supersededBy` pointing to the active successor.
   - **Unconfirmed Proposal Isolation (`packet.pendingDecisions`)**: Any Decision proposal (`P-*`) left unconfirmed by Session 1 must **never** appear in `decisions.active`; it must be isolated in `pendingDecisions` with `confirmed === false` and `status === "PENDING / NOT CONFIRMED"`.
   - **CLI / MCP Parity**: `projectContext` (CLI) and `MCP_TOOLS.duo_get_context` (MCP) must return identical `activeIds`, `historyIds`, and `pendingIds`.
2. **Session 2 Output Surface (`projectReview`)**:
   - **Compliant Edit**: A Session 2 edit that follows the active Decision must produce `0` blocking claims (`verdict === "PASS"`, or `verdict === "ASK"` when an unconfirmed proposal in scope requires human decision).
   - **Violating Edit**: A Session 2 edit that violates the active Decision (or follows an obsolete superseded Decision) must be rejected with `verdict === "BLOCK"` and a blocking `CONFLICT` claim citing the exact active Decision ID.

---

## 2. Handoff Scenarios (`H1` – `H3`)

| Scenario | Session 1 State (Agent A: `codex-session-1`) | Session 2 Task (Agent B: `claude-session-2`, fresh session) | Expected ContextPacket Invariants | Expected Review Verdicts |
| :--- | :--- | :--- | :--- | :--- |
| **H1** | Proposes and human confirms `D-001` (`forbids.imported_paths: ["src/legacy/payment.ts"]` in `src/billing/**`), refactors `src/billing/invoice.ts`, commits, and indexes. | Update refund logic in `src/billing/refund.ts` (`BILLING-01`). | `active: [D-001]`, `history: []`, `pending: []` | Compliant (`payment-gateway.ts`) → `PASS`<br>Violating (`legacy/payment.ts`) → `BLOCK` (`D-001`) |
| **H2** | Confirms `D-001`, then supersedes it with `D-002` (`supersedes: "D-001"`, `forbids.imported_paths: ["src/legacy/payment-v1.ts"]`), commits, and indexes. | Update checkout flow in `src/billing/checkout.ts` (`BILLING-01`). | `active: [D-002]`, `history: [D-001 -> D-002]`, `pending: []` | Compliant (`payment-v2.ts`) → `PASS`<br>Obsolete v1 (`payment-v1.ts`) → `BLOCK` (`D-002`) |
| **H3** | Confirms `D-001`, then proposes `P-002` (`forbids.symbols: ["*DraftAuditLogger*"]`, `supersedes: "D-001"`) **without** human confirmation. | Update refund logic in `src/billing/refund.ts` (`BILLING-01`). | `active: [D-001]`, `history: []`, `pending: [P-002]` | Compliant with `D-001` (even with `DraftAuditLogger`) → `ASK` (`0` blocking claims)<br>Violating `D-001` (`legacy/payment.ts`) → `BLOCK` (`D-001`) |

---

## 3. Measured No-LLM Verification Results

Run the automated test suite or CLI report generator:

```bash
node --test bench/decision-continuity/oracle.test.ts
node bench/decision-continuity/run.mjs
node bench/decision-continuity/run.mjs --json
```

| Scenario | Description | Classification | Active Decisions | Superseded History | Pending Proposals | Compliant Verdict | Violating Verdict | Cited Decision | Duration (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: |
| **H1** | Confirmed forbidden-import Decision (D-001) continuity from Session 1 to Session 2 | `continuity-verified` | `D-001` | none | none | `PASS` | `BLOCK` | `D-001` | 3830 |
| **H2** | Superseded Decision (D-001 -> D-002) isolation in history and enforcement of active D-002 | `continuity-verified` | `D-002` | `D-001` | none | `PASS` | `BLOCK` | `D-002` | 3456 |
| **H3** | Unconfirmed proposal (P-002) isolated in pendingDecisions (triggers ASK, never BLOCK) while confirmed D-001 stays active and enforced | `continuity-verified` | `D-001` | none | `P-002` | `ASK` | `BLOCK` | `D-001` | 3495 |

---

## 4. Paid-Run Protocol Plan (Awaiting Maintainer Approval)

Per Issue #33 (`[AGT-01]`), live paid agent runs (`Codex → Codex` and `Codex → Claude Code`) are **not** executed automatically in CI. Below is the session budget and protocol for maintainer sign-off before running paid sessions.

### 4.1 Experimental Matrix

- **Conditions**:
  - **Baseline (`No DUO`)**: Repository contains written architecture rules in `AGENTS.md` / `CLAUDE.md` and commit history from Session 1, without DUO MCP tools or hooks.
  - **Treatment (`DUO Enabled`)**: Repository initialized with `duoctl init`, `duoctl index`, and agent integration installed via `duoctl install codex` and `duoctl install claude`.
- **Agent Handoff Pairs**:
  1. **Same-Agent Handoff**: `Codex CLI (Session 1) → Codex CLI (Session 2)`
  2. **Cross-Agent Handoff**: `Codex CLI (Session 1) → Claude Code (Session 2)`

### 4.2 Estimated Paid Session Count

| Execution Mode | Scenarios | Agent Pairs | Conditions (`Baseline` vs `DUO`) | Live Sessions per Handoff | Total Paid Agent Sessions |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Recommended (Deterministic Session 1 + Live Session 2)** | 3 (`H1`, `H2`, `H3`) | 2 (`Codex→Codex`, `Codex→Claude`) | 2 | 1 (Session 2 only; Session 1 state prepared by `oracle.mjs`) | **12 sessions** |
| **Full Live Handoff (Live Session 1 + Live Session 2)** | 3 (`H1`, `H2`, `H3`) | 2 (`Codex→Codex`, `Codex→Claude`) | 2 | 2 (Both Session 1 and Session 2 run live) | **24 sessions** |

> **Recommendation**: Use the **12-session protocol** (Deterministic Session 1 + Live Session 2) so that every Session 2 agent starts from an identical, reproducible git commit and `.duo-project` state.

### 4.3 Per-Session Evaluation Protocol

For each of the 12 live Session 2 runs:
1. Materialize the post-Session-1 repository fixture (`H1`, `H2`, or `H3`) in an isolated temporary directory.
2. Launch the Session 2 agent (`codex exec` or `claude -p`) with a fresh session and the Session 2 task prompt (e.g., `"Implement processRefund in src/billing/refund.ts for BILLING-01"`).
3. Record four binary outcomes from the transcript and post-run repository state:
   - **`contextCalled`**: Did Session 2 call `duo_get_context` (`DUO` condition)?
   - **`activeRuleRespected`**: Did the final worktree satisfy the active Decision (`D-001` in `H1`/`H3`, `D-002` in `H2`) with `0` blocking claims under `projectReview`?
   - **`supersededRuleAvoided`** (`H2`): Did Session 2 avoid importing obsolete `src/legacy/payment-v1.ts`?
   - **`pendingProposalHandled`** (`H3`): Did Session 2 recognize `P-002` as unconfirmed (`PENDING / NOT CONFIRMED`) and surface the question rather than treating `P-002` as already confirmed truth?
