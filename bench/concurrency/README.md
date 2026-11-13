# Multi-Agent Concurrency Consistency Stress Suite (Issue #34 / AGT-02)

Local, LLM-free stress and verification suite for multi-agent and multi-process concurrency against a single DUO repository (and linked Git worktrees). Opt-in local benchmark and test suite; not a mandatory CI gate.

## Overview

When multiple coding agents (e.g. Claude Code, Codex, Cursor) or parallel CLI/MCP sessions operate on the same repository at the same time, they contend on `.duo-project/` state files and caches. This suite compares the final repository state of concurrent executions against a **Sequential Baseline** executed on an identical fixture repository and classifies each scenario into one of three categories:

| Classification | Oracle Invariant |
| :--- | :--- |
| **`safe`** | All concurrent workers succeed (`ok: true`), and the final repository snapshot (`.duo-project/decisions/`, `proposals/`, `graph.sqlite` canonical node/edge dump, `index-state.json` token, and `work-tasks.json`) matches the sequential baseline with zero corrupted files or dangling locks. |
| **`explicit-error`** | Contending workers that lose a race are rejected with an explicit, documented DUO diagnostic code (`GRAPH_WRITE_REFUSED`, `DECISION_LOCK_BUSY`, `AGENT_PLAN_STALE`, etc.), while the winning state remains 100% valid, uncorrupted, lock-free, and equivalent to a valid sequential run. |
| **`silent-inconsistency`** | Any lost update (a worker reports success while its write is overwritten), corrupted YAML/JSON/SQLite file, mismatch between `index-state.json` token and `graph.sqlite` `index_state_token`, `checkGraph()` invariant violation, leftover `.lock` / `.duo.bak` file, or unclassified error. |

## Files

| File | Role | Uses LLM |
| :--- | :--- | :---: |
| [oracle.mjs](oracle.mjs) | Captures deterministic repository snapshots (`captureRepoSnapshot`), evaluates the 3-tier concurrency oracle (`evaluateConcurrencyOracle`), and implements Scenarios C1–C6 with full temporary directory cleanup | no |
| [run.mjs](run.mjs) | CLI stress runner executing Scenarios C1–C6 and printing a Markdown findings table or JSON report (`--json`, `--output <path>`) | no |
| [oracle.test.ts](oracle.test.ts) | Unit tests for the 3-tier oracle classification rules (including T180 `index-writer.lock` and fingerprint invariants) and integration tests for Scenarios C1, C1b, C2, C3, C4, C5, C6a, and C6b | no |

## Reproduce

Build the workspace once, then run the unit/integration test suite and the stress runner:

```bash
pnpm build
node --test bench/concurrency/oracle.test.ts
node bench/concurrency/run.mjs
```

To emit machine-readable JSON or save the report to disk:

```bash
node bench/concurrency/run.mjs --json --output bench/results/local/concurrency-report.json
```

All scenarios create self-contained temporary Git repositories under `os.tmpdir()` and remove them (including linked Git worktrees via `git worktree remove --force`) in `finally` blocks across Windows, macOS, and Linux.

## Measured Findings

Measured locally on Node `v24.18.0` (`win32 x64`):

| ID | Scenario | Workers | Succeeded | Failed | Classification | Explicit Diagnostic Codes | Baseline Equivalence |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :---: |
| **C1** | 6 agents concurrently proposing Decisions (`DecisionService.propose`) | 6 | 6 | 0 | `safe` | — | 100% match |
| **C1b** | 3 agents proposing while `decisions.lock` is held past `lockTimeoutMs` | 3 | 0 | 3 | `explicit-error` | `DECISION_LOCK_BUSY` | 100% match |
| **C2a** | 4 workers concurrently indexing a cold repository (`indexRepository`) | 4 | 4 | 0 | `safe` | — | 100% match |
| **C2b** | 4 workers concurrently running incremental index after source edit | 4 | 4 (or >= 1 under contention) | 0 (or >= 1) | `safe` / `explicit-error` | — / `GRAPH_WRITE_REFUSED` | 100% match |
| **C3** | 6 agents concurrently calling `projectContext` and `projectReview` on active diff | 6 | 6 | 0 | `safe` | — | 100% match |
| **C4** | 6 MCP sessions concurrently updating Work-Map activity (`work-tasks.lock`) | 6 | 6 | 0 | `safe` | — | 100% match |
| **C5** | 2 agents concurrently proposing, indexing, and compiling context in Git worktrees | 2 | 2 | 0 | `safe` | — | 100% match |
| **C6a** | 6 agents concurrently triggering automatic index recovery across source edit & history move | 12 (2×6) | 12 | 0 | `safe` | — | 100% match |
| **C6b** | 4 workers attempting automatic index recovery under active `index-writer.lock` contention + post-release recovery | 4 | 0 (then 4) | 4 (then 0) | `explicit-error` (then `safe`) | `GRAPH_WRITE_REFUSED` | 100% match |

## Architectural Observations

1. **Decision Proposals (`C1`, `C1b`)**: `DecisionService` serializes mutations through `.duo-project/runtime/locks/decisions.lock` (`createExclusive` spin-wait with dead-PID recovery) and writes proposal YAML files exclusively (`wx`). Concurrent proposals allocate contiguous IDs (`P-001`..`P-006`) without lost updates (`safe`). When lock contention exceeds `lockTimeoutMs`, callers receive `DECISION_LOCK_BUSY` (`explicit-error`) without partial writes.
2. **Graph Indexing & Persistent OS Lock (`C2a`, `C2b`, T180)**: `indexRepository` serializes writers through the OS-level SQLite file lock on `.duo-project/generated/index-writer.lock` (`withIndexWriteLock`), which remains on disk as a 0-byte regular file after connection close, and also guards `tx.readMeta(INDEX_STATE_TOKEN_KEY) !== previous.token` inside `BEGIN IMMEDIATE`. Every completed index run keeps `graph.db` (`index_state_token`), `index-state.json` (`token`), and `fingerprints.json` in 3-way agreement.
3. **Concurrent Read / Review & MCP Work-Map (`C3`, `C4`)**: Parallel `projectContext` and `projectReview` calls over a dirty working tree return identical seed counts, verdicts, and claim counts as sequential execution (`safe`). Concurrent MCP tool invocations (`duo_get_context`, `duo_review_changes`) serialize `.duo-project/runtime/work-tasks.json` updates via `.duo-project/runtime/work-tasks.lock` and atomic `.tmp` file renames (`safe`).
4. **Separate Git Worktrees (`C5`)**: Because each Git worktree maintains its own working tree and `.duo-project/` state directory while sharing the underlying Git object database, concurrent agents operating in separate worktrees (`git worktree add`) do not contend on `.duo-project/` locks or SQLite files (`safe`).
5. **Automatic Stale-Index Recovery (`C6a`, `C6b`, Issue #4 / T179–T182)**: When the index becomes `stale` (either from a tracked source edit or a history-only `HEAD` move), concurrent MCP reads (`duo_get_context`, `duo_review_changes`) and `refreshIndexIfSafe` calls serialize on `.duo-project/generated/index-writer.lock`. Exactly one worker rebuilds the index (`refreshed: true`) per stale round while the remaining workers observe the newly current index (`refreshed: false`) and return fresh context/review payloads matching the sequential baseline (`safe`). If another writer holds `index-writer.lock` past `lockTimeoutMs`, `refreshIndexIfSafe` refuses with `GRAPH_WRITE_REFUSED` (`Index lock timeout`) and MCP callers stay `index-required` without corrupting the existing graph (`explicit-error`), recovering cleanly once the lock is released.
