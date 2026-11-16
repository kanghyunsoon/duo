# Zero-friction UX measurement specification (Jira 249)

Status: local measurement specification and three CLI functional reproductions recorded on 2026-10-23. This is not evidence that the #2 UX goals have been met.

## 1. Completion states

Keep the following conclusions separate.

| State | Rule | Current state |
|---|---|---|
| Plan adequate | The plan covers the #2 targets, the #3/#4/#5 dependencies, fixture conditions, evidence collection, and Jira's completion route. | Draft, pending maintainer review of the requested corrections. |
| Local deliverable ready | This document, its runnable script, one raw trace containing three cases, and documented checks exist. The raw trace is available only in the local workspace; reviewers can reproduce its checks from section 5. | Yes: the embedded script replay and checks in section 9 passed. |
| Jira 249 complete | The Jira DoD is satisfied through an approved submission route. | No. Draft PR #82 is open; this document records no Jira research comment, non-author approval, merge, or three-OS verification. |

Jira 249's current DoD permits either a linked PR approved by a non-author and merged after Windows, Ubuntu, and macOS verification, or a research result recorded on the Jira issue. This document prepares the research result; posting it requires separate authorization.

## 2. #2 targets and common measurement rules

The values below reproduce [GitHub issue #2](https://github.com/kanghyunsoon/duo/issues/2). T69 and T74 are historical release baselines, not current measurements.

| Measure | Target |
|---|---:|
| Setup after package install | 1 DUO command plus external project trust |
| Human DUO commands during normal coding | 0 |
| Agent `duoctl index` commands per task | 0 |
| First context request returning `INDEX_REQUIRED` | 0 |
| Tasks with valid context and valid review | 7/7 |
| Decision approval | one preview and one explicit human confirmation per Decision |
| Manual housekeeping after Decision approval | 0 |
| First useful result | at most five minutes |
| Noise WARNs on fixed fixtures | 0 |
| Agent MCP discovery | at least 6/7 under the same condition |

- Count a human or Agent shell command once per attempted invocation, including failures and retries. Fixture provisioning commands are logged separately and are excluded from UX command totals.
- Count every MCP tool request once. A retry is another request. Report failed and successful requests separately.
- Context succeeds only if it is valid for the task and target revision and can be used without unresolved staleness. Review succeeds only if it inspects the changed revision and supplies its diff and claim evidence.
- A Decision approval measurement needs the human-visible preview and one explicit human confirmation. TTY tests and programmatic fixture confirmation validate behavior but are excluded from human approval UX counts.
- For MCP discovery, freeze a seven-task manifest containing the exact task-specific prompt, Agent configuration, model/client version, fixture revision, and whether DUO use was explicitly requested. Calculate `>=6/7` only within one identical guidance condition; guided and unguided runs are separate cohorts.
- A WARN without settled policy records the expected claim, whether attention is needed, its evidence, and `policy: provisional`. It is not a pass/fail result for the zero-noise target.

### Time clocks

Record both clocks:

1. `t_package`: immediately after a successful package installation. The comparable #2 duration is `first useful result - t_package`; it includes every later preparation and wait.
2. `t_first`: immediately before the first setup command. `first useful result - t_first` is an operational metric and is not comparable to the original five-minute target.

Before `t_package`, only an already-downloaded local fixture archive, temporary workspace creation, and pre-existing OS/Node/Git/Agent availability are allowed. Fixture extraction, project dependency installation, agent integration or trust, rule entry, Decision proposal/preview/confirmation, and waits after `t_package` remain in the #2 clock. `first useful result` means the first valid review for a fixed changed revision, including its verdict, changed-file diff, and evidence. A first-run result is measured only when the complete setup and a real Decision preview/confirmation journey are run. Neither clock is measured by the local reproductions below.

## 3. Fixture catalogue for #5 and follow-up work

Every execution records the fixture ID, starting revision, exact edit, fixed expectation, policy state, command/MCP ledger, exit codes, raw output, and source/Truth manifests.

| Fixture | Frozen edit and expectation | Policy / evidence condition |
|---|---|---|
| R7 README whole-file provenance | Init accepts the README goal suggestion (`acceptSuggestion: true`), recording a section-less README hash in `vision.md`; change only `## Development`. Expected `WARN`, `external-source-drift`, `PARTIAL`, `external-source-changed`. | #7's current behavior. Attention is required under the current product behavior; a zero-noise policy is pending. Evidence: accepted whole-file provenance, changed README hunk, unchanged Truth. |
| N-code Scheduler | Current index, then change `Scheduler.next` from `% 7` to `% 5`. Expected current review `PASS`, positive `scope-relevance / ALIGNED / in-task-context`, no Requirement drift, no outside-task claim, and no Decision claim. | Normal control case. Evidence: `Scheduler.next` context, scheduler diff, review evidence. |
| C259 other-milestone Requirement | Start from `fixtures/review/app` at a recorded HEAD; before the measured edit, set `RPT-01` milestone to M2 in `.duo-project/specs/report.md`, create `.duo-project/milestones/M2.yaml` with `id: M2`, `title: Next report milestone`, `state: planned`, and keep `project.yaml` current milestone M1. Commit that fixture baseline. Refactor `return { total: Math.floor(cents / 100) };` to `const total = Math.floor(cents / 100); return { total };`. | Expected `requirement-implementation / PARTIAL / outside-current-milestone`; no functional rounding change. Attention provisionally unnecessary under #5. Evidence: both milestone Truth definitions, original/revised source, and review diff. Record actual verdict separately. |
| C260 natural-language task | Use pinned `packages/director/src/review/task-scope-c260.e2e.test.ts` F1 at a recorded HEAD with `context.max_depth: 1`; task `Fix HTTPError message formatting`; replace `return error instanceof HTTPError;` with `return error instanceof HTTPError && error.name === "HTTPError";` in `source/errors/HTTPError.ts`. | Current expected `scope-relevance / UNKNOWN / outside-task-context`, `WARN`; attention provisionally unnecessary under #5. Evidence: task, depth, context seed `HTTPError`, diff seed `isHTTPError`, exact hunk. Keep N1/N2 as unrelated-file controls; record actual verdict separately. |
| D001 safety control | Confirm a Decision forbidding `src/db/legacy-db.ts`, then add the customer-history import. | Expected `BLOCK` with `decision-forbids-import / CONFLICT / forbidden-import`; attention required. Evidence: Decision, line 3 import, hunk, and resolved target. |

The small local check executes R7, N-code with stale recovery, and D001. C259 and C260 remain frozen follow-up fixtures because #5's final WARN policy has not been agreed.

## 4. Current and target stale behavior

| Surface | Current baseline | #4 target |
|---|---|---|
| CLI | `context` and `review` stop with `index-required`; an explicit index or explicit `--refresh` is required. | Keep the explicit CLI control unless #4 changes it. |
| MCP | A stale request returns `index-required`; the MCP server does not index. | Safely refresh once, visibly, without changing source or Truth, then return valid context/review. |
| Decision confirmation followed by stale index | Record whether `index-required` occurs and whether an explicit index restores valid results. Count the explicit action as housekeeping. | A safe automatic refresh gives valid results with zero manual housekeeping. It does not count as a reproduction failure. |
| Truth integrity error | An invalid confirmed Decision/lock blocks valid results until a person restores Truth. | Same safety boundary: no automated Truth repair, confirmation, or PASS. |

For every stale comparison, use the same code manifest, Truth manifest, request name, arguments, task, and `from/to` revision. Only the index state changes. Preserve a relevant dirty-worktree patch and affected untracked files outside the repository with their hashes; otherwise record that the measured build has no related dirty source. The implementation shown below compares complete source and Truth manifests while excluding only generated/index/cache/runtime data.

## 5. Reproduction script and evidence format

Save the following as `replay.mjs`, set `DUO_REPO` to the checkout, and run `node replay.mjs`. It creates disposable Git fixtures and writes a full JSON trace outside the repository at `DUO_249_EVIDENCE` (default: `Documents/duo-evidence/jira-249-YYYYMMDD`). Each trace uses a timestamp, process ID, and UUID in its filename and is opened with exclusive creation, so reruns cannot overwrite earlier evidence. The script intentionally creates the D001 Decision through the core service; it is fixture setup, not a human approval UX measurement.

```js
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.DUO_REPO ?? process.cwd();
const cli = path.join(repo, "apps/cli/dist/main.js");
const evidenceDir = process.env.DUO_249_EVIDENCE ?? path.join(os.homedir(), "Documents", "duo-evidence", "jira-249-" + new Date().toISOString().slice(0, 10).replaceAll("-", ""));
const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid + "-" + randomUUID();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const env = { ...process.env, GIT_AUTHOR_NAME: "DUO 249 fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "DUO 249 fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const ledger = [];
const git = (root, ...args) => { const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }); const out = { kind: "fixture-git", root, args, exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; ledger.push(out); if (r.status !== 0) throw new Error(JSON.stringify(out)); return out.stdout; };
const duo = (root, args, input = "") => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: "utf8", windowsHide: true }); const out = { kind: "duo-shell", root, command: "duoctl " + args.join(" "), args, input, exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; try { out.packet = JSON.parse(out.stdout); } catch {} ledger.push(out); return out; };
function fixture(name, files) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "duo-249-" + name + "-")); for (const [f, v] of Object.entries(files)) write(root, f, v); git(root, "init", "-q"); git(root, "config", "core.autocrlf", "false"); git(root, "config", "user.name", "DUO 249 fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", "-A"); git(root, "commit", "-qm", "initial"); return root; }
function init(root, acceptedReadme = false) { const a = acceptedReadme ? { question: "project_goal", value: "The service calculates invoices.", acceptSuggestion: true } : { question: "project_goal", value: "Keep recurring chores fair." }; const r = duo(root, ["init", "--non-interactive", "--answers", "-", "--json"], JSON.stringify([a])); if (r.exitCode !== 0) throw new Error(r.stdout + r.stderr); git(root, "add", "-A"); git(root, "commit", "-qm", "adopt DUO"); return r; }
function manifest(root, truth) { return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).map(String).map((f) => f.split(path.sep).join("/")).filter((f) => !f.startsWith(".git/") && (truth ? f.startsWith(".duo-project/") && !/^\.duo-project\/(?:generated|cache|runtime)\//.test(f) : !f.startsWith(".duo-project/"))).filter((f) => fs.statSync(path.join(root, f)).isFile()).sort().map((f) => ({ path: f, sha256: sha(fs.readFileSync(path.join(root, f))) })); }
const head = (root) => git(root, "rev-parse", "HEAD").trim();
const trace = { format: "duo.jira-249-replay/3", repo, cases: {} };
const checks = [];
const check = (caseId, name, pass) => checks.push({ caseId, name, pass: Boolean(pass) });
let failure;
let createDecisionService;
let output;

function saveTrace() {
  trace.ledger = ledger;
  trace.checks = checks;
  fs.mkdirSync(evidenceDir, { recursive: true });
  output = path.join(evidenceDir, "replay-" + runId + ".json");
  fs.writeFileSync(output, JSON.stringify(trace, null, 2), { flag: "wx" });
  return sha(fs.readFileSync(output));
}

try {
  const documentText = fs.readFileSync(path.join(repo, "docs/validation/zero-friction-ux-249.md"), "utf8").replace(/\r\n/g, "\n");
  const scriptSection = documentText.match(/```js\n([\s\S]*?)\n```/)?.[1];
  if (!scriptSection) throw new Error("Embedded replay script was not found");
  trace.scriptSha256 = sha(Buffer.from(scriptSection));
  ({ createDecisionService } = await import(pathToFileURL(path.join(repo, "packages/core/dist/index.js")).href));
  { const r = fixture("readme", { "README.md": "# Invoice service\n\nThe service calculates invoices.\n\n## Development\n\nUse pnpm test before release.\n", "package.json": "{\"name\":\"invoice-service\",\"type\":\"module\"}\n" }); const c = trace.cases.readme = { root: r, initialRevision: head(r), expected: { verdict: "WARN", claim: "external-source-drift/PARTIAL/external-source-changed" } }; c.setup = init(r, true); c.adoptionRevision = head(r); c.visionBefore = { text: fs.readFileSync(path.join(r, ".duo-project/intent/vision.md"), "utf8"), sha256: sha(fs.readFileSync(path.join(r, ".duo-project/intent/vision.md"))) }; write(r, "README.md", fs.readFileSync(path.join(r, "README.md"), "utf8").replace("Use pnpm test before release.", "Use pnpm test and lint before release.")); c.before = { source: manifest(r, false), truth: manifest(r, true) }; c.index = duo(r, ["index", "--json"]); c.review = duo(r, ["review", "--json"]); c.after = { source: manifest(r, false), truth: manifest(r, true) }; }

  { const files = { "README.md": "# Orbit Tasks\n\nKeep recurring chores fair.\n", "package.json": "{\"name\":\"orbit-tasks\",\"type\":\"module\"}\n", "src/scheduler.ts": "import { step30 } from \"./steps/step30.js\";\n\nexport class Scheduler {\n  next(day: number): number {\n    return step30(day) % 7;\n  }\n}\n" }; for (let i = 1; i <= 30; i++) { const n = String(i).padStart(2, "0"), prev = String(i - 1).padStart(2, "0"); files["src/steps/step" + n + ".ts"] = (i === 1 ? "" : `import { step${prev} } from "./step${prev}.js";\n\n`) + `export function step${n}(input: number): number { return ${i === 1 ? "input + 1" : `step${prev}(input) + ${i}`}; }\n`; } const r = fixture("scheduler", files); const c = trace.cases.scheduler = { root: r, initialRevision: head(r), expected: { staleExit: 6, context: "ready", verdict: "PASS", claim: "scope-relevance/ALIGNED/in-task-context" } }; c.setup = init(r); c.adoptionRevision = head(r); write(r, "src/scheduler.ts", fs.readFileSync(path.join(r, "src/scheduler.ts"), "utf8").replace("% 7", "% 5")); c.before = { source: manifest(r, false), truth: manifest(r, true) }; c.staleContext = duo(r, ["context", "Scheduler.next", "--json"]); c.staleReview = duo(r, ["review", "--task", "Scheduler.next", "--json"]); c.index = duo(r, ["index", "--json"]); c.afterIndex = { source: manifest(r, false), truth: manifest(r, true) }; c.context = duo(r, ["context", "Scheduler.next", "--json"]); c.review = duo(r, ["review", "--task", "Scheduler.next", "--json"]); c.after = { source: manifest(r, false), truth: manifest(r, true) }; c.manifestUnchanged = JSON.stringify(c.before) === JSON.stringify(c.afterIndex) && JSON.stringify(c.before) === JSON.stringify(c.after); }

  { const r = fixture("forbidden", { "README.md": "# Orbit Tasks\n\nKeep recurring chores fair.\n", "package.json": "{\"name\":\"orbit-tasks\",\"type\":\"module\"}\n", "src/db/legacy-db.ts": "export class LegacyDb { run(sql) { return [sql]; } }\n" }); const c = trace.cases.forbidden = { root: r, initialRevision: head(r), expected: { verdict: "BLOCK", claim: "decision-forbids-import/CONFLICT/forbidden-import", evidence: "src/ui/customer-history-page.ts:1-5" } }; c.setup = init(r); c.adoptionRevision = head(r); write(r, ".duo-project/decisions/D-001.yaml", "id: D-001\ntitle: No legacy-db imports\nkind: decision\nstate: proposed\nquestion: legacy_db\nanswer: Code does not import src/db/legacy-db.ts\nforbids:\n  imported_paths: [\"src/db/legacy-db.ts\"]\nenforcement: block\n"); c.proposedDecision = { text: fs.readFileSync(path.join(r, ".duo-project/decisions/D-001.yaml"), "utf8"), sha256: sha(fs.readFileSync(path.join(r, ".duo-project/decisions/D-001.yaml"))) }; const confirmed = await createDecisionService({ root: r }).confirm({ kind: "human", name: "Fixture Setup" }, "D-001"); c.confirmation = JSON.parse(JSON.stringify(confirmed)); if (!confirmed.value) throw new Error(JSON.stringify(confirmed.diagnostics)); c.confirmedDecision = { text: fs.readFileSync(path.join(r, ".duo-project/decisions/D-001.yaml"), "utf8"), sha256: sha(fs.readFileSync(path.join(r, ".duo-project/decisions/D-001.yaml"))) }; c.confirmedDecision.lock = c.confirmedDecision.text.match(/lock:\n\s+digest:\s*(sha256:[0-9a-f]{64})/)?.[1] ?? null; git(r, "add", "-A"); git(r, "commit", "-qm", "confirm D-001"); c.confirmedRevision = head(r); write(r, "src/ui/customer-history-page.ts", "// Customer history page.\n\nimport { LegacyDb } from \"../db/legacy-db.js\";\n\nexport const rows = new LegacyDb().run(\"x\");\n"); c.before = { source: manifest(r, false), truth: manifest(r, true) }; c.index = duo(r, ["index", "--json"]); c.review = duo(r, ["review", "--json"]); c.after = { source: manifest(r, false), truth: manifest(r, true) }; }

  const claims = (r) => (r.packet?.result?.claims ?? []).map((c) => [c.rule, c.alignment, c.reason].join("/"));
  const a = trace.cases.readme, s = trace.cases.scheduler, f = trace.cases.forbidden;
  const hasWholeFileSource = /^\s*source:\s*\n\s*- path: README\.md\n\s+hash: sha256:[0-9a-f]{64}$/m.test(a.visionBefore.text) && !/\n\s+section:/.test(a.visionBefore.text);
  check("readme", "whole-file provenance", a.setup.packet?.result?.plan?.questions?.[0]?.evidence?.[0]?.path === "README.md" && hasWholeFileSource && a.before.truth.some((x) => x.path === ".duo-project/intent/vision.md"));
  check("readme", "Truth unchanged", JSON.stringify(a.before.truth) === JSON.stringify(a.after.truth));
  check("readme", "WARN claim and README hunk", a.index.exitCode === 0 && a.review.exitCode === 0 && a.review.packet?.result?.verdict === a.expected.verdict && claims(a.review).includes(a.expected.claim) && a.review.packet?.result?.diff?.files?.some((x) => x.path === "README.md" && x.hunks.some((h) => h.newStart === 7)));
  check("scheduler", "stale responses", s.staleContext.exitCode === s.expected.staleExit && s.staleReview.exitCode === s.expected.staleExit && s.staleContext.packet?.result?.status === "index-required" && s.staleReview.packet?.result?.status === "index-required");
  check("scheduler", "source and Truth unchanged", s.manifestUnchanged && s.index.exitCode === 0 && JSON.stringify(s.staleReview.args) === JSON.stringify(s.review.args) && JSON.stringify(s.staleContext.args) === JSON.stringify(s.context.args));
  check("scheduler", "current context and review", s.context.exitCode === 0 && s.context.packet?.result?.context?.packet?.code?.some((x) => x.ref === "src/scheduler.ts#Scheduler.next" && x.text.includes("% 5")) && s.review.exitCode === 0 && s.review.packet?.result?.verdict === s.expected.verdict && claims(s.review).includes(s.expected.claim) && s.review.packet?.result?.diff?.files?.some((x) => x.path === "src/scheduler.ts" && x.hunks.some((h) => h.newStart === 5)) && !claims(s.review).some((x) => /requirement-implementation|decision-forbids-import|outside-task-context/.test(x)));
  check("forbidden", "Decision reconstruction", Boolean(f.initialRevision && f.adoptionRevision && f.confirmedRevision && f.confirmation?.value && f.confirmedDecision.lock && /state: confirmed/.test(f.confirmedDecision.text) && /imported_paths:/.test(f.confirmedDecision.text) && JSON.stringify(f.before.truth) === JSON.stringify(f.after.truth)));
  check("forbidden", "BLOCK with exact import evidence", f.index.exitCode === 0 && f.review.exitCode === 0 && f.review.packet?.result?.verdict === f.expected.verdict && claims(f.review).includes(f.expected.claim) && f.review.packet?.result?.evidence?.some((x) => x.pointer?.path === "src/ui/customer-history-page.ts" && x.pointer?.lines?.[0] === 3 && x.metadata?.resolvedTo === "src/db/legacy-db.ts"));
  trace.passed = checks.every((x) => x.pass);
} catch (error) {
  failure = { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
  trace.failure = failure;
  trace.passed = false;
} finally {
  try {
    const traceSha256 = saveTrace();
    console.log(output, traceSha256, JSON.stringify(checks));
  } catch (writeError) {
    trace.persistenceFailure = { name: writeError instanceof Error ? writeError.name : "Error", message: writeError instanceof Error ? writeError.message : String(writeError) };
    console.error(JSON.stringify(trace.persistenceFailure));
    process.exitCode = 1;
  }
}
if (failure || !trace.passed) process.exitCode = 1;
```

The trace stores complete stdout/stderr packets, exact arguments and init stdin, exit codes, fixture Git attempts, source/Truth manifests, assertion results, and a hash of this embedded script. It normalizes CRLF to LF before extracting its code fence. The `try/finally` boundary includes document loading and core-module loading, so a normal bootstrap, fixture, Git, or DUO failure is written as a partial trace; an evidence-directory write failure is reported on stderr. Unique, exclusively created trace files preserve every attempt. A failed assertion or execution error makes the process exit 1. Do not replace the `expected` objects after execution. Any discrepancy starts an investigation and is recorded as a discrepancy; it never changes an expectation retroactively.

## 6. 2026-10-23 execution record

Build identity: the measurement ran on the #80 branch `codex/ui-a11y-73`, checked out at HEAD `8a7715cc0580fd5a64631b36b923779a69b9f047`, based on `next` SHA `0521fd77c0681988a09a27f0ea826d983bb52563`. The measured application source matched tested-code SHA `73ec8ecb6d0d5568f65cb1148e97d92cbc7da01d`; the later HEAD differs only by the #80 audit report, so it introduced no related application-source changes. Environment: Node `v24.18.0`; pnpm `11.25.0`; Vitest `5.0.2`; Windows PowerShell. At measurement time, this document was an untracked local draft and unrelated Java target outputs were present; neither was used by the fixtures. `pnpm build` completed with exit 0 before the replay.

The raw trace is retained outside the repository at `<evidence-root>/jira-249-20261023-final-p3/replay-2026-10-23T12-20-13-504Z-17620-ac389605-93db-4734-aa2b-973de26e6944.json` (SHA-256 `ec2511474675995acd76d6515cace559fa7aca0b4ade94b087cbb82c6397397c`). Reviewers cannot access that local trace; they can reproduce its checks by saving the JavaScript code block in section 5 as `replay.mjs`, running `pnpm build` and then `node .\replay.mjs` from the repository root. The embedded script SHA-256 is `64bffae41ddb4acd3d8f4b7cd5754b93dcb610625c64b20eabf3a623884da1a6`; a successful replay must report eight passing assertions. The recorded trace SHA-256 identifies the original run. Reruns use a unique timestamp, process ID, UUID, and disposable fixture paths, so their trace SHA-256 will differ; the embedded-script SHA-256 remains stable when the code block is unchanged. Two consecutive missing-checkout runs both exited 1 and produced distinct failure traces. The earlier exploratory trace is retained separately under `<evidence-root>/jira-249-20261023/`.

| Case | Fixed expectation before execution | Actual observation | Result |
|---|---|---|---|
| R7 README | `WARN`; `external-source-drift / PARTIAL / external-source-changed`; only `README.md:7` changes after whole-file README provenance is accepted. | Exit 0; `WARN`; the required claim and reason appeared. Evidence included a section-less `vision.md` whole-file source, README hunk `7-7`, and before/after source and Truth manifests. The five Truth entries were byte-identical. | Matches. This confirms current #7 behavior, not a zero-noise success. |
| N-code Scheduler stale | Before refresh: context and review exit 6, `index-required`. After one index: context `ready`; review `PASS`, `scope-relevance / ALIGNED / in-task-context`; no Requirement/Decision claim. | Stale context and review both exit 6. Post-index context exit 0 `ready`; review exit 0 `PASS` with the expected positive claim. Its diff was `src/scheduler.ts:5`, `% 7` to `% 5`. Complete source and Truth manifests were byte-identical before and after index. | Matches the current CLI baseline. It does not measure #4 MCP auto-refresh. |
| D001 forbidden import | `BLOCK`; `decision-forbids-import / CONFLICT / forbidden-import`; evidence covers customer-history `1-5` and offending import line 3. | Exit 0; `BLOCK` with the expected claim. Evidence resolved `../db/legacy-db.js` to `src/db/legacy-db.ts` and pointed to line 3. The trace preserves initial, adoption, and confirmed revisions; proposed/confirmed Decision text and hashes; confirmation result; lock digest; and before/after source and Truth manifests. | Matches. Programmatic fixture confirmation is excluded from human UX measurements. |

### Recomputable ledger

| Boundary | R7 | Scheduler | D001 |
|---|---:|---:|---:|
| Fixture provisioning commands | Git initialization/commits; not UX measurements | Git initialization/commits; not UX measurements | Git initialization/commits plus programmatic Decision setup; not UX measurements |
| DUO shell invocations | 3: init, index, review | 6: init, stale context, stale review, index, current context, current review | 3: init, index, review |
| DUO shell retries | 0 | 0 | 0 |
| MCP requests | 0 | 0 | 0 |
| Human approval interactions | 0 | 0 | 0 |

The replay's 45-entry `ledger` lists every fixture Git attempt and every DUO command with raw stdout/stderr and exit code; each DUO packet also retains exact stdin and parsed structured output when available. The `finally` trace additionally records any thrown setup/command failure. The table counts only the fixed three-case measurement run. Earlier exploratory attempts belong to development history and are excluded from this run's denominators. The script uses a direct core call solely to construct the already-confirmed D001 fixture. It does not simulate a real preview or explicit human confirmation and contributes zero to Decision UX metrics.

## 7. Unmeasured and follow-up procedures

- The five-minute goal, first-command operational duration, full onboarding, external trust, Agent index count, normal human coding count, real human Decision approval, and seven-task MCP discovery are unmeasured.
- The #4 MCP stale behavior has a repository E2E regression test, but no MCP raw packet was collected in this three-case CLI replay. A future MCP run must use the seven-task manifest and capture every request/result.
- After Decision approval, preserve identical source/Truth/request arguments while checking baseline `index-required` plus explicit recovery against the #4 automatic-recovery target. Record manual index/cleanup as housekeeping.
- For a Truth integrity fault, mutate confirmed Decision content without changing its lock. Context/review must be unusable until a person restores the saved valid Truth. Capture diagnostics, status, restoration source, and post-restoration results.
- T69 reconstruction search, performed on 2026-10-23, covered the repository's canonical audit `docs/roadmap/0.3.1-t69-zero-friction-ux-audit.md`, its links from `docs/README.md` and `docs/conflicts.md`, and the current workspace Git history and untracked files. The audit itself supplies three repository starting revisions (`ky` `3541888`, `commander.js` `ba6d13d`, `click` `2247b35`), eight task labels (A-T1 through A-T4, B-T1 through B-T2, C-T1 through C-T2), and abbreviated prompts. It does not contain the complete original Agent prompts, per-task start/end revisions, Agent/model/configuration transcripts, or a reconciled explanation of its “seven tasks” claim. No separate local transcript or measurement artifact was found in that search. Historical identical-configuration reproduction remains incomplete. Resume only after recovering those materials and resolving the 7-versus-8 discrepancy; otherwise label any replacement as a new study.

## 8. Repository references

- `tests/mcp/mcp.e2e.test.ts` documents current MCP stale behavior: stale context/review return `index-required`, the MCP server does not index, and CLI indexing restores usable results.
- `tests/cli/cli.tty.test.ts` verifies preview-before-confirm and typed confirmation boundaries. It is behavioral coverage, not a human UX timing result.
- `tests/cli/review-evidence-line.e2e.test.ts` supplies the D001 evidence-line fixture.
- `packages/director/src/review/record.e2e.test.ts` supplies section-specific external-source drift coverage. It is supplementary to the whole-file R7 reproduction above.

## 9. Verification record

The following commands must pass after any edit to this document:

```text
pnpm docs:validate
git diff --check
explicit trailing-whitespace scan of docs/validation/zero-friction-ux-249.md
```

Validation results from the original execution before the review corrections:

| Command | Exit status | Result |
|---|---:|---|
| `pnpm docs:validate` | 0 | 152 files, 52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, and 226 links validated. |
| `git diff --check` | 0 | No whitespace errors in tracked diff. |
| Explicit trailing-whitespace scan of the document | 0 | No trailing whitespace. |
| `pnpm vitest run packages/director/src/review/record.e2e.test.ts -t "R-DRIFT"` | 0 | 4 passed, 9 skipped. |
| `pnpm vitest run tests/mcp/mcp.e2e.test.ts -t "same MCP process sees a stale index"` | 0 | 1 passed, 19 skipped. |
| `pnpm vitest run tests/cli/review-evidence-line.e2e.test.ts` | 0 | 1 passed. |

The embedded replay exited 0 with all eight assertions passing. The evidence file's SHA-256 and embedded script SHA-256 are recorded in the handoff. Draft PR #82 is open. This local execution record does not include a Jira research comment, non-author approval, merge, three-OS verification, or Jira status transition.

After the review corrections in this document, `pnpm docs:validate` passed with 153 files, 52 requirements, 14 decisions, 22 issues, 5 milestones, 94 acceptance criteria, and 226 links. `git diff --check` and the trailing-whitespace scan also passed.
