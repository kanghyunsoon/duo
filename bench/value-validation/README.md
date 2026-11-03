# Value Validation 01 tools

Protocol and results: [docs/validation/value-validation-01](../../docs/validation/value-validation-01/README.md). Benchmark-local code; not part of the DUO package.

| File | What it does | Uses Codex |
|---|---|---|
| `fixture.mjs` | Builds the orders-app repository for condition A, B or C, with the setup steps timed | no |
| `cases.mjs` | The 17 deterministic cases with their ground truth and each checker's declared scope | no |
| `detect.mjs` | Part 1: applies every case to a copy of the C repository and runs the B gate (ESLint + check-deps) and `duoctl review --refresh --fail-on block` | no |
| `oracle.mjs` | Independent judge for agent runs: new violations of R1–R3 against the adoption commit; computed module paths go to a person | no |
| `tasks.mjs` | The 7 agent tasks, the same prompt in every condition, hidden acceptance tests | no |
| `agent.mjs` | Part 2 harness: seeded balanced schedule, fresh repository per run, `codex exec --json` with a pinned model, metrics, oracle, acceptance test. `--selftest` checks the oracle against the 17 cases; `--dry-run` builds everything without Codex | yes, only with `--model` and `--i-understand-this-uses-codex` |
| `discovery.mjs` | Part 3 (#8): published 0.3.2 vs 0.3.3, real Codex tool discovery, first-call success, CLI fallback; `--dry-run` measures server startup only | yes, same guard |
| `aggregate.mjs` | Turns results into the protocol's tables; unmeasured values stay NOT MEASURED | no |
| `measure.mjs` | Pure measurement helpers used by `agent.mjs` and `aggregate.mjs`: Codex event parsing (usage `null` unless every `turn.completed` event has complete usage; cached `null` unless every event reports it), totals and medians that become `null` when any run value is missing, measured-run counts | no |
| `measure.test.mjs` | Regression tests for the NOT MEASURED rule, run by `pnpm test` and CI (`vitest.config.ts` includes `bench/value-validation/**/*.test.mjs`) | no |
| `claude-measure.mjs` | Pure parser for the final `result` of `claude -p --output-format json` or `stream-json`: tokens (cache creation and cache read kept apart), `duration_ms`, `duration_api_ms`, `total_cost_usd` as an estimate; `null` when the result is missing or repeated, usage and cost `null` on a crash, budget stop or API error. Not wired into a harness | no |
| `claude-measure.test.mjs` | Regression tests for that parser against `fixtures/claude/` (official-doc shapes plus a real failed and a real successful CLI 2.1.263 run, reduced to structure and numbers) | no |
| `results/detection-01.json` | Part 1 raw result (2026-10-15) | |

```bash
# Part 1 (no LLM, no network besides the installed packages)
node bench/value-validation/detect.mjs --duoctl <duoctl.js of @duo-director/cli@0.3.3> --core packages/core/dist/index.js --eslint node_modules/eslint/bin/eslint.js --work <dir> --out <dir>/detection.json
node bench/value-validation/aggregate.mjs --detection <dir>/detection.json

# Oracle self-test and a dry run of Part 2 (no Codex)
node bench/value-validation/agent.mjs --selftest --out <dir>
node bench/value-validation/agent.mjs --dry-run --reps 1 --out <dir> --duoctl <duoctl.js> --duoctl-bin <dir holding the duoctl command> --core packages/core/dist/index.js

# Part 2 and Part 3 use the runner's own Codex login and quota; run them only after approval
node bench/value-validation/agent.mjs --out <dir> --duoctl <duoctl.js> --duoctl-bin <dir> --core packages/core/dist/index.js --model <model> --i-understand-this-uses-codex
node bench/value-validation/discovery.mjs --out <dir> --runs 10 --model <model> --i-understand-this-uses-codex
```

Raw session logs stay in the output directory and are not committed. No credential is copied: Codex runs with the runner's normal configuration, and the test repository is trusted only through a command-line override.
