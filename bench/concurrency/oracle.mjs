/**
 * Issue #34 ([AGT-02]): Ground-truth concurrency oracle for multi-agent / multi-process DUO runs.
 *
 * Compares the final repository state of a concurrent execution against a sequential baseline
 * on an identical fixture repository, and classifies each scenario into one of three categories:
 *   - "safe": all concurrent operations succeeded and final repository state is equivalent to
 *     the sequential baseline with zero corruption, invariant violations, or dangling locks.
 *   - "explicit-error": one or more concurrent operations were rejected with a documented DUO
 *     concurrency diagnostic (e.g. GRAPH_WRITE_REFUSED, DECISION_LOCK_TIMEOUT, AGENT_PLAN_STALE),
 *     while the repository state remains valid, uncorrupted, and consistent.
 *   - "silent-inconsistency": any lost update, corrupted YAML/JSON/SQLite file, graph invariant
 *     violation, index-state token mismatch, dangling lock file, or unclassified error.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultAnalyzerRegistry } from "@duo-director/analyzer";
import {
  createDecisionService,
  listDecisionProposals,
  loadProjectTruth,
  parseYaml,
  truthAuthorityErrors,
  verifyDecisionLock,
} from "@duo-director/core";
import {
  checkGraph,
  dumpGraph,
  GRAPH_DB_FILE_PATH,
  GRAPH_REVISION_KEY,
  INDEX_STATE_FILE_PATH,
  INDEX_STATE_TOKEN_KEY,
  indexRepository,
  openProjectGraphReader,
  openProjectGraphStore,
  readIndexState,
} from "@duo-director/graph";
import {
  LLMProviderPool,
  MCP_TOOLS,
  projectContext,
  projectReview,
} from "@duo-director/integration";

/** Documented explicit concurrency/contention diagnostic codes in DUO. */
export const EXPLICIT_CONCURRENCY_CODES = new Set([
  "GRAPH_WRITE_REFUSED",
  "DECISION_LOCK_BUSY",
  "DECISION_CONFIRM_PREVIEW_CHANGED",
  "DECISION_SESSION_CONFLICT",
  "REVIEW_SNAPSHOT_MISMATCH",
  "INIT_PLAN_STALE",
  "AGENT_PLAN_STALE",
  "WORK_TASKS_LOCK_TIMEOUT",
  "SQLITE_BUSY",
]);

/**
 * Walk `.duo-project` to detect leftover `.lock` or `.duo.bak` files after workers settle,
 * and verify that every `.yaml` / `.json` file under `.duo-project` parses cleanly.
 */
function inspectStateFiles(root) {
  const stateRoot = path.join(root, ".duo-project");
  const danglingLocks = [];
  const corruptedFiles = [];
  if (!fs.existsSync(stateRoot)) {
    return { danglingLocks, corruptedFiles };
  }

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name.endsWith(".lock") || entry.name.endsWith(".duo.bak")) {
        danglingLocks.push(relPath);
        continue;
      }
      if (entry.name.endsWith(".json")) {
        try {
          JSON.parse(fs.readFileSync(fullPath, "utf8"));
        } catch (error) {
          corruptedFiles.push({
            path: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
        const parsed = parseYaml({ path: relPath, text: fs.readFileSync(fullPath, "utf8") });
        if (parsed.diagnostics.length > 0) {
          corruptedFiles.push({
            path: relPath,
            reason: parsed.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "),
          });
        }
      }
    }
  };

  walk(stateRoot);
  return {
    danglingLocks: danglingLocks.sort(),
    corruptedFiles,
  };
}

/**
 * Capture a deterministic, side-effect-free snapshot of a DUO repository's state surfaces:
 *   1. Project Truth (`.duo-project/decisions/`, `.duo-project/decisions/proposals/`, lock digests)
 *   2. Project Graph (`.duo-project/cache/graph.sqlite`, `index-state.json`, `checkGraph`, `dumpGraph`)
 *   3. Work Map & Runtime files (`.duo-project/runtime/work-tasks.json`, `.duo-project/cache/work-map.json`)
 *   4. File integrity & leftover locks (`danglingLocks`, `corruptedFiles`)
 */
export function captureRepoSnapshot(root) {
  const { danglingLocks, corruptedFiles } = inspectStateFiles(root);

  // 1. Project Truth & Decisions / Proposals
  const loaded = loadProjectTruth(root);
  const proposalEntries = loaded.value ? listDecisionProposals(loaded.value.truth) : [];
  const truthDiagnostics = truthAuthorityErrors(loaded.diagnostics).map((d) => ({
    code: d.code,
    message: d.message,
  }));
  for (const entry of proposalEntries) {
    if (entry.cleanupPending) {
      truthDiagnostics.push({
        code: "DECISION_PROPOSAL_CLEANUP_PENDING",
        message: `Proposal ${entry.id} is committed to ${entry.decisionId} but cleanup is still pending`,
      });
    }
  }

  const decisions = (loaded.value?.truth.decisions ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    state: d.state,
    question: d.question,
    answer: d.answer,
    lockStatus: d.state === "confirmed" ? verifyDecisionLock(d, loaded.value.truth).status : "unconfirmed",
  })).sort((a, b) => a.id.localeCompare(b.id));

  const proposals = (loaded.value?.truth.proposals ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    state: p.state,
    question: p.question,
    answer: p.answer,
    proposedBy: p.proposedBy ?? "",
    proposedByKind: p.proposedByKind ?? "",
  })).sort((a, b) => a.id.localeCompare(b.id));

  // Content signatures are order-independent so concurrent permutations of ID allocation
  // (e.g. Agent A gets P-002 and Agent B gets P-001) can be compared against sequential baseline.
  const decisionSignatures = decisions
    .map((d) => `${d.title}|${d.state}|${d.question}|${d.answer}|${d.lockStatus}`)
    .sort();
  const proposalSignatures = proposals
    .map((p) => `${p.title}|${p.state}|${p.question}|${p.answer}|${p.proposedByKind}:${p.proposedBy}`)
    .sort();
  const proposalIds = proposals.map((p) => p.id).sort();
  const decisionIds = decisions.map((d) => d.id).sort();

  // 2. Project Graph & Index State
  const dbPath = path.join(root, GRAPH_DB_FILE_PATH);
  const statePath = path.join(root, INDEX_STATE_FILE_PATH);
  let graph = {
    exists: false,
    ok: true,
    dbToken: undefined,
    stateToken: undefined,
    tokenMatched: true,
    revision: undefined,
    inspectionStatus: undefined,
    invariantDiagnostics: [],
    dump: { nodes: [], edges: [] },
  };

  if (fs.existsSync(dbPath) || fs.existsSync(statePath)) {
    const stateResult = readIndexState(root);
    const readerResult = openProjectGraphReader(root);
    if (!readerResult.value) {
      graph = {
        exists: true,
        ok: false,
        dbToken: undefined,
        stateToken: stateResult.state?.token,
        tokenMatched: false,
        revision: undefined,
        inspectionStatus: stateResult.problem ?? "error",
        invariantDiagnostics: readerResult.diagnostics.map((d) => ({ code: d.code, message: d.message })),
        dump: { nodes: [], edges: [] },
      };
    } else {
      const store = readerResult.value;
      try {
        const dbToken = store.readMeta(INDEX_STATE_TOKEN_KEY);
        const revision = store.readMeta(GRAPH_REVISION_KEY);
        const stateToken = stateResult.state?.token;
        const invariantDiagnostics = [
          ...stateResult.diagnostics,
          ...checkGraph(store, stateResult.state ? { fingerprints: stateResult.state.files } : {}),
        ].map((d) => ({ code: d.code, message: d.message }));
        const dump = dumpGraph(store);
        const tokenMatched = dbToken !== undefined && stateToken !== undefined && dbToken === stateToken;
        graph = {
          exists: true,
          ok: invariantDiagnostics.length === 0 && tokenMatched,
          dbToken,
          stateToken,
          tokenMatched,
          revision,
          inspectionStatus: stateResult.problem ?? "ok",
          invariantDiagnostics,
          dump,
        };
      } finally {
        store.close();
      }
    }
  }

  // 3. Work Map & Runtime Tasks
  const workTasksPath = path.join(root, ".duo-project/runtime/work-tasks.json");
  let workTasksCount = 0;
  let workTasksSignatures = [];
  if (fs.existsSync(workTasksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(workTasksPath, "utf8"));
      const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
      workTasksCount = tasks.length;
      workTasksSignatures = tasks
        .map((t) => `${t.agent ?? t.agentName ?? ""}|${t.name ?? ""}|${t.status ?? ""}|${t.targetRef ?? ""}|${t.review?.verdict ?? ""}`)
        .sort();
    } catch {
      // Already recorded in corruptedFiles by inspectStateFiles
    }
  }

  return {
    truth: {
      ok: loaded.value !== undefined && truthDiagnostics.length === 0,
      diagnostics: truthDiagnostics,
      decisionIds,
      decisionSignatures,
      proposalIds,
      proposalSignatures,
    },
    graph,
    workTasks: {
      count: workTasksCount,
      signatures: workTasksSignatures,
    },
    danglingLocks,
    corruptedFiles,
  };
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Evaluate a concurrency run against a sequential baseline snapshot and classify the outcome:
 *   - "safe"
 *   - "explicit-error"
 *   - "silent-inconsistency"
 */
export function evaluateConcurrencyOracle({
  scenario,
  baselineSnapshot,
  concurrentSnapshot,
  outcomes,
  checkTruthEquivalence = true,
  checkGraphEquivalence = true,
  checkWorkTasksEquivalence = false,
}) {
  const silentReasons = [];
  const explicitErrorCodes = new Set();
  const unclassifiedErrors = [];

  let succeededCount = 0;
  let failedCount = 0;

  for (const outcome of outcomes) {
    if (outcome.ok) {
      succeededCount++;
    } else {
      failedCount++;
      const codes = Array.isArray(outcome.codes) ? outcome.codes : [];
      if (codes.length === 0) {
        unclassifiedErrors.push(outcome.error ?? "Failed without diagnostic code");
      } else {
        for (const code of codes) {
          if (EXPLICIT_CONCURRENCY_CODES.has(code)) {
            explicitErrorCodes.add(code);
          } else {
            unclassifiedErrors.push(`${code}: ${outcome.error ?? "unexpected diagnostic"}`);
          }
        }
      }
    }
  }

  // 1. Structural & Integrity Checks on Concurrent Snapshot
  if (concurrentSnapshot.corruptedFiles.length > 0) {
    silentReasons.push(
      `Corrupted files detected: ${concurrentSnapshot.corruptedFiles.map((f) => `${f.path} (${f.reason})`).join(", ")}`,
    );
  }
  if (concurrentSnapshot.danglingLocks.length > 0) {
    silentReasons.push(`Dangling lock/backup files left behind: ${concurrentSnapshot.danglingLocks.join(", ")}`);
  }
  if (!concurrentSnapshot.truth.ok) {
    silentReasons.push(
      `Project Truth invalid after concurrent run: ${concurrentSnapshot.truth.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  if (unclassifiedErrors.length > 0) {
    silentReasons.push(`Unclassified worker failure(s): ${unclassifiedErrors.join("; ")}`);
  }
  if (succeededCount === 0 && outcomes.length > 0 && explicitErrorCodes.size === 0) {
    silentReasons.push("All concurrent workers failed without an explicit concurrency code");
  }

  // 2. Graph Invariant & Baseline Equivalence Checks
  const graphNodesEqual = arraysEqual(baselineSnapshot.graph.dump.nodes, concurrentSnapshot.graph.dump.nodes);
  const graphEdgesEqual = arraysEqual(baselineSnapshot.graph.dump.edges, concurrentSnapshot.graph.dump.edges);
  if (checkGraphEquivalence && (baselineSnapshot.graph.exists || concurrentSnapshot.graph.exists)) {
    if (!concurrentSnapshot.graph.ok) {
      silentReasons.push(
        `Graph invariant or token check failed: ${concurrentSnapshot.graph.invariantDiagnostics.map((d) => `${d.code}: ${d.message}`).join("; ") || "token mismatch"}`,
      );
    }
    if (!concurrentSnapshot.graph.tokenMatched) {
      silentReasons.push(
        `index-state.json token (${concurrentSnapshot.graph.stateToken}) does not match graph.sqlite token (${concurrentSnapshot.graph.dbToken})`,
      );
    }
    if (succeededCount > 0 && (!graphNodesEqual || !graphEdgesEqual)) {
      silentReasons.push(
        `Graph dump differs from sequential baseline (baseline: ${baselineSnapshot.graph.dump.nodes.length}N/${baselineSnapshot.graph.dump.edges.length}E vs concurrent: ${concurrentSnapshot.graph.dump.nodes.length}N/${concurrentSnapshot.graph.dump.edges.length}E)`,
      );
    }
  }

  // 3. Truth Equivalence & Lost-Update Detection
  const decisionsEqual =
    arraysEqual(baselineSnapshot.truth.decisionIds, concurrentSnapshot.truth.decisionIds) &&
    arraysEqual(baselineSnapshot.truth.decisionSignatures, concurrentSnapshot.truth.decisionSignatures);
  const proposalsEqual =
    arraysEqual(baselineSnapshot.truth.proposalIds, concurrentSnapshot.truth.proposalIds) &&
    arraysEqual(baselineSnapshot.truth.proposalSignatures, concurrentSnapshot.truth.proposalSignatures);

  if (checkTruthEquivalence) {
    if (failedCount === 0) {
      if (!decisionsEqual) {
        silentReasons.push("Confirmed decisions differ from sequential baseline despite all workers succeeding");
      }
      if (!proposalsEqual) {
        silentReasons.push(
          `Proposals differ from sequential baseline despite all workers succeeding (baseline=${baselineSnapshot.truth.proposalIds.length}, concurrent=${concurrentSnapshot.truth.proposalIds.length})`,
        );
      }
    } else {
      // Partial success under contention: count of new proposals must match succeededCount + initial proposals
      const expectedProposals =
        baselineSnapshot.truth.proposalIds.length - (outcomes.length - succeededCount);
      if (
        baselineSnapshot.truth.proposalIds.length >= outcomes.length &&
        concurrentSnapshot.truth.proposalIds.length !== expectedProposals
      ) {
        silentReasons.push(
          `Proposal count (${concurrentSnapshot.truth.proposalIds.length}) does not match succeeded worker count (${expectedProposals})`,
        );
      }
    }
  }

  // 4. Work-Tasks Equivalence & Lost-Update Detection
  const workTasksEqual = arraysEqual(
    baselineSnapshot.workTasks.signatures,
    concurrentSnapshot.workTasks.signatures,
  );
  if (checkWorkTasksEquivalence && failedCount === 0 && !workTasksEqual) {
    silentReasons.push(
      `Work-tasks state differs from sequential baseline despite all workers succeeding (baseline=${baselineSnapshot.workTasks.count}, concurrent=${concurrentSnapshot.workTasks.count})`,
    );
  }

  let classification = "safe";
  if (silentReasons.length > 0) {
    classification = "silent-inconsistency";
  } else if (failedCount > 0 && explicitErrorCodes.size > 0) {
    classification = "explicit-error";
  }

  return {
    scenario,
    classification,
    totalWorkers: outcomes.length,
    succeededCount,
    failedCount,
    explicitErrorCodes: [...explicitErrorCodes].sort(),
    silentReasons,
    equivalence: {
      decisionsEqual,
      proposalsEqual,
      graphNodesEqual,
      graphEdgesEqual,
      workTasksEqual,
    },
  };
}

/**
 * Create a self-contained, LLM-free temporary git repository with `.duo-project` truth
 * and TypeScript source files for concurrency testing.
 */
export function createConcurrencyFixtureRepo(prefix = "duo-concurrency-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const write = (relPath, content) => {
    const target = path.join(root, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };

  write(".gitignore", ".duo-project/generated/\n.duo-project/cache/\n.duo-project/runtime/\n");
  write(".duo-project/project.yaml", "schema_version: 1\nname: concurrency-fixture\n");
  write(
    ".duo-project/specs/auth.md",
    "# Auth\n\n## AUTH-01 Session Validation\n\n```duo\nstatus: in_progress\n```\n\nValidate user sessions deterministically.\n",
  );
  write(
    ".duo-project/decisions/D-001.yaml",
    [
      "id: D-001",
      "title: Token session validation",
      "kind: decision",
      "state: proposed",
      "question: session_validation_strategy",
      "answer: signed_token",
      "governs:",
      "  requirements: [AUTH-01]",
      "enforcement: block",
      "",
    ].join("\n"),
  );
  write(
    "tsconfig.json",
    JSON.stringify(
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
  );
  write(
    "src/session.ts",
    [
      "export interface SessionToken {",
      "  readonly userId: string;",
      "  readonly issuedAt: number;",
      "}",
      "",
      "export function verifySession(token: SessionToken): boolean {",
      "  return token.userId.length > 0 && token.issuedAt > 0;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/handler.ts",
    [
      "import { verifySession, type SessionToken } from './session.js';",
      "",
      "// @duo AUTH-01",
      "export function handleRequest(token: SessionToken): string {",
      "  return verifySession(token) ? `ok:${token.userId}` : 'unauthorized';",
      "}",
      "",
    ].join("\n"),
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "DUO Concurrency Test",
    GIT_AUTHOR_EMAIL: "concurrency@example.invalid",
    GIT_COMMITTER_NAME: "DUO Concurrency Test",
    GIT_COMMITTER_EMAIL: "concurrency@example.invalid",
  };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
    env: gitEnv,
  });
  execFileSync("git", ["config", "core.autocrlf", "false"], {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
    env: gitEnv,
  });

  return root;
}

/**
 * Scenario C1: Multiple agents concurrently proposing Decisions on the same repository.
 * Compares N sequential `DecisionService.propose` calls against N concurrent `propose` calls.
 */
export async function runScenarioConcurrentDecisionProposals({ workerCount = 6, lockTimeoutMs = 5_000 } = {}) {
  const seqRoot = createConcurrencyFixtureRepo("duo-c1-seq-");
  const concRoot = createConcurrencyFixtureRepo("duo-c1-conc-");
  const human = { kind: "human", name: "maintainer" };
  const clock = () => new Date("2026-10-27T00:00:00.000Z");

  try {
    await createDecisionService({ root: seqRoot, clock }).confirm(human, "D-001");
    await createDecisionService({ root: concRoot, clock }).confirm(human, "D-001");

    const buildInput = (index) => ({
      actor: { kind: "agent", name: `agent-${index + 1}` },
      proposal: {
        title: `Concurrent proposal ${index + 1}`,
        question: `concurrency_question_${index + 1}`,
        answer: `answer_${index + 1}`,
        governs: { requirements: ["AUTH-01"] },
      },
    });

    // Sequential Baseline
    for (let i = 0; i < workerCount; i++) {
      const { actor, proposal } = buildInput(i);
      const service = createDecisionService({ root: seqRoot, clock, lockTimeoutMs });
      const res = await service.propose(actor, proposal);
      if (!res.value) {
        throw new Error(`Sequential baseline failed: ${JSON.stringify(res.diagnostics)}`);
      }
    }

    // Concurrent Execution
    const outcomes = await Promise.all(
      Array.from({ length: workerCount }, async (_, i) => {
        const { actor, proposal } = buildInput(i);
        const service = createDecisionService({ root: concRoot, clock, lockTimeoutMs });
        const result = await service.propose(actor, proposal);
        return {
          ok: result.value !== undefined && result.diagnostics.length === 0,
          value: result.value,
          codes: result.diagnostics.map((d) => d.code),
          error: result.diagnostics.map((d) => d.message).join("; "),
        };
      }),
    );

    const baselineSnapshot = captureRepoSnapshot(seqRoot);
    const concurrentSnapshot = captureRepoSnapshot(concRoot);
    return evaluateConcurrencyOracle({
      scenario: "C1:concurrent-decision-propose",
      baselineSnapshot,
      concurrentSnapshot,
      outcomes,
      checkTruthEquivalence: true,
      checkGraphEquivalence: false,
    });
  } finally {
    fs.rmSync(seqRoot, { recursive: true, force: true });
    fs.rmSync(concRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario C2: Multiple agents concurrently running `indexRepository` on the same repository.
 * Compares sequential `indexRepository` against N concurrent `indexRepository` calls.
 */
export async function runScenarioConcurrentGraphIndex({ workerCount = 4, preIndex = false } = {}) {
  const seqRoot = createConcurrencyFixtureRepo("duo-c2-seq-");
  const concRoot = createConcurrencyFixtureRepo("duo-c2-conc-");
  const human = { kind: "human", name: "maintainer" };
  const clock = () => new Date("2026-10-27T00:00:00.000Z");

  const registryResult = await createDefaultAnalyzerRegistry();
  const registry = registryResult.value;
  if (!registry) {
    throw new Error(`Failed to initialize analyzer registry: ${JSON.stringify(registryResult.diagnostics)}`);
  }

  try {
    await createDecisionService({ root: seqRoot, clock }).confirm(human, "D-001");
    await createDecisionService({ root: concRoot, clock }).confirm(human, "D-001");

    const runOneIndex = async (targetRoot) => {
      const storeResult = openProjectGraphStore(targetRoot);
      if (!storeResult.value) {
        return {
          ok: false,
          value: undefined,
          codes: storeResult.diagnostics.map((d) => d.code),
          error: storeResult.diagnostics.map((d) => d.message).join("; "),
        };
      }
      const store = storeResult.value;
      try {
        const result = await indexRepository(targetRoot, { store, registry });
        const errorDiagnostics = result.diagnostics.filter((d) => d.severity === "error");
        return {
          ok: result.value !== undefined && errorDiagnostics.length === 0,
          value: result.value,
          codes: errorDiagnostics.map((d) => d.code),
          error: errorDiagnostics.map((d) => d.message).join("; "),
        };
      } finally {
        store.close();
      }
    };

    if (preIndex) {
      const warmSeq = await runOneIndex(seqRoot);
      const warmConc = await runOneIndex(concRoot);
      if (!warmSeq.ok || !warmConc.ok) {
        throw new Error(`Pre-index warmup failed: ${warmSeq.error || warmConc.error}`);
      }
      // Mutate a source file identically in both repos so incremental index has real work to commit
      const mutation = "\nexport const CONCURRENCY_REV = 2;\n";
      fs.appendFileSync(path.join(seqRoot, "src/session.ts"), mutation, "utf8");
      fs.appendFileSync(path.join(concRoot, "src/session.ts"), mutation, "utf8");
    }

    // Sequential Baseline
    for (let i = 0; i < workerCount; i++) {
      const res = await runOneIndex(seqRoot);
      if (!res.ok) {
        throw new Error(`Sequential index baseline failed: ${res.error}`);
      }
    }

    // Concurrent Execution
    const outcomes = await Promise.all(
      Array.from({ length: workerCount }, () => runOneIndex(concRoot)),
    );

    const baselineSnapshot = captureRepoSnapshot(seqRoot);
    const concurrentSnapshot = captureRepoSnapshot(concRoot);
    return evaluateConcurrencyOracle({
      scenario: preIndex ? "C2b:concurrent-graph-index-incremental" : "C2a:concurrent-graph-index-cold",
      baselineSnapshot,
      concurrentSnapshot,
      outcomes,
      checkTruthEquivalence: true,
      checkGraphEquivalence: true,
    });
  } finally {
    registry.dispose();
    fs.rmSync(seqRoot, { recursive: true, force: true });
    fs.rmSync(concRoot, { recursive: true, force: true });
  }
}

function gitExec(root, args) {
  execFileSync("git", args, {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "DUO Concurrency Test",
      GIT_AUTHOR_EMAIL: "concurrency@example.invalid",
      GIT_COMMITTER_NAME: "DUO Concurrency Test",
      GIT_COMMITTER_EMAIL: "concurrency@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z",
    },
  });
}

async function prepareCommittedIndexedRepo(root, registry) {
  const human = { kind: "human", name: "maintainer" };
  const clock = () => new Date("2026-10-27T00:00:00.000Z");
  await createDecisionService({ root, clock }).confirm(human, "D-001");
  gitExec(root, ["add", "-A"]);
  gitExec(root, ["commit", "-qm", "initial confirmed truth and source"]);

  const storeResult = openProjectGraphStore(root);
  if (!storeResult.value) {
    throw new Error(`Failed to open graph store: ${JSON.stringify(storeResult.diagnostics)}`);
  }
  try {
    const idx = await indexRepository(root, { store: storeResult.value, registry });
    if (!idx.value) {
      throw new Error(`Initial index failed: ${JSON.stringify(idx.diagnostics)}`);
    }
  } finally {
    storeResult.value.close();
  }
}

/**
 * Scenario C3: Multiple agents concurrently running read/analysis operations (`projectContext` and `projectReview`)
 * against the same indexed repository with an active working-tree diff.
 */
export async function runScenarioConcurrentContextAndReview({ workerCount = 6 } = {}) {
  const seqRoot = createConcurrencyFixtureRepo("duo-c3-seq-");
  const concRoot = createConcurrencyFixtureRepo("duo-c3-conc-");
  const registryResult = await createDefaultAnalyzerRegistry();
  const registry = registryResult.value;
  if (!registry) {
    throw new Error(`Failed to initialize analyzer registry: ${JSON.stringify(registryResult.diagnostics)}`);
  }

  try {
    await prepareCommittedIndexedRepo(seqRoot, registry);
    await prepareCommittedIndexedRepo(concRoot, registry);

    // Create an identical working-tree modification in both repos so reviewChanges inspects a real diff
    const workingTreeEdit = "\nexport function isSessionExpired(issuedAt: number, now: number): boolean {\n  return now - issuedAt > 3600_000;\n}\n";
    fs.appendFileSync(path.join(seqRoot, "src/handler.ts"), workingTreeEdit, "utf8");
    fs.appendFileSync(path.join(concRoot, "src/handler.ts"), workingTreeEdit, "utf8");

    // Re-index after edit so index status is current for both context and review
    for (const root of [seqRoot, concRoot]) {
      const store = openProjectGraphStore(root).value;
      try {
        await indexRepository(root, { store, registry });
      } finally {
        store?.close();
      }
    }

    const runWorkerOp = async (root, index) => {
      if (index % 2 === 0) {
        const op = await projectContext(
          root,
          { task: "AUTH-01 src/handler.ts" },
          { registry },
        );
        return {
          ok: op.kind === "ok" && op.payload.status === "ready",
          signature:
            op.kind === "ok"
              ? `context:${op.payload.status}:seeds=${op.payload.context.resolution?.seeds.length ?? 0}`
              : `context:failed`,
          codes: op.diagnostics.map((d) => d.code),
          error: op.diagnostics.map((d) => d.message).join("; "),
        };
      }
      const op = await projectReview(
        root,
        {
          diff: { from: "HEAD", to: "WORKTREE" },
          task: "AUTH-01 src/handler.ts",
        },
        { registry },
      );
      return {
        ok: op.kind === "ok" && op.payload.status === "ready",
        signature:
          op.kind === "ok"
            ? `review:${op.payload.status}:verdict=${op.payload.verdict ?? "none"}:claims=${op.payload.claims.length}`
            : `review:failed`,
        codes: op.diagnostics.map((d) => d.code),
        error: op.diagnostics.map((d) => d.message).join("; "),
      };
    };

    const seqSignatures = [];
    for (let i = 0; i < workerCount; i++) {
      const res = await runWorkerOp(seqRoot, i);
      if (!res.ok) {
        throw new Error(`Sequential C3 baseline failed at worker ${i}: ${res.error}`);
      }
      seqSignatures.push(res.signature);
    }

    const outcomes = await Promise.all(
      Array.from({ length: workerCount }, (_, i) => runWorkerOp(concRoot, i)),
    );
    const concSignatures = outcomes.map((o) => o.signature);

    const baselineSnapshot = captureRepoSnapshot(seqRoot);
    const concurrentSnapshot = captureRepoSnapshot(concRoot);
    const oracleResult = evaluateConcurrencyOracle({
      scenario: "C3:concurrent-context-and-review",
      baselineSnapshot,
      concurrentSnapshot,
      outcomes,
      checkTruthEquivalence: true,
      checkGraphEquivalence: true,
    });

    if (
      oracleResult.classification === "safe" &&
      JSON.stringify(seqSignatures) !== JSON.stringify(concSignatures)
    ) {
      return {
        ...oracleResult,
        classification: "silent-inconsistency",
        silentReasons: [
          ...oracleResult.silentReasons,
          `Context/Review payload signatures differed from sequential baseline: ${JSON.stringify(concSignatures)} vs ${JSON.stringify(seqSignatures)}`,
        ],
      };
    }
    return oracleResult;
  } finally {
    registry.dispose();
    fs.rmSync(seqRoot, { recursive: true, force: true });
    fs.rmSync(concRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario C4: Multiple MCP agent sessions concurrently invoking `duo_get_context` and
 * `duo_review_changes`, contending on `.duo-project/runtime/work-tasks.lock` and updating
 * `.duo-project/runtime/work-tasks.json`.
 */
export async function runScenarioConcurrentWorkMapActivity({ workerCount = 6 } = {}) {
  const seqRoot = createConcurrencyFixtureRepo("duo-c4-seq-");
  const concRoot = createConcurrencyFixtureRepo("duo-c4-conc-");
  const registryResult = await createDefaultAnalyzerRegistry();
  const registry = registryResult.value;
  if (!registry) {
    throw new Error(`Failed to initialize analyzer registry: ${JSON.stringify(registryResult.diagnostics)}`);
  }

  try {
    await prepareCommittedIndexedRepo(seqRoot, registry);
    await prepareCommittedIndexedRepo(concRoot, registry);

    const llm = new LLMProviderPool();
    const runMcpSession = async (root, index) => {
      const ctx = {
        root,
        agentName: `agent-${index + 1}`,
        duoSessionId: `session-${index + 1}`,
        signal: new AbortController().signal,
        llm,
      };
      const task = `AUTH-01 src/handler.ts session-${index + 1}`;
      const contextRun = await MCP_TOOLS.duo_get_context.run({ task }, ctx);
      const reviewRun = await MCP_TOOLS.duo_review_changes.run({ task }, ctx);
      const diagnostics = [...contextRun.op.diagnostics, ...reviewRun.op.diagnostics];
      return {
        ok: contextRun.op.kind === "ok" && reviewRun.op.kind === "ok",
        codes: diagnostics.map((d) => d.code),
        error: diagnostics.map((d) => d.message).join("; "),
      };
    };

    for (let i = 0; i < workerCount; i++) {
      const res = await runMcpSession(seqRoot, i);
      if (!res.ok) {
        throw new Error(`Sequential C4 baseline failed at session ${i}: ${res.error}`);
      }
    }

    const outcomes = await Promise.all(
      Array.from({ length: workerCount }, (_, i) => runMcpSession(concRoot, i)),
    );

    const baselineSnapshot = captureRepoSnapshot(seqRoot);
    const concurrentSnapshot = captureRepoSnapshot(concRoot);
    return evaluateConcurrencyOracle({
      scenario: "C4:concurrent-mcp-work-map-activity",
      baselineSnapshot,
      concurrentSnapshot,
      outcomes,
      checkTruthEquivalence: true,
      checkGraphEquivalence: true,
      checkWorkTasksEquivalence: true,
    });
  } finally {
    registry.dispose();
    fs.rmSync(seqRoot, { recursive: true, force: true });
    fs.rmSync(concRoot, { recursive: true, force: true });
  }
}

/**
 * Scenario C5: Multiple agents operating concurrently in separate Git worktrees (`git worktree add`)
 * backed by the same underlying Git repository, running `indexRepository`, `DecisionService.propose`,
 * and `projectContext` in parallel.
 */
export async function runScenarioConcurrentGitWorktrees() {
  const seqMainRoot = createConcurrencyFixtureRepo("duo-c5-seq-main-");
  const concMainRoot = createConcurrencyFixtureRepo("duo-c5-conc-main-");
  const seqWtRoot = `${seqMainRoot}-wt`;
  const concWtRoot = `${concMainRoot}-wt`;

  const registryResult = await createDefaultAnalyzerRegistry();
  const registry = registryResult.value;
  if (!registry) {
    throw new Error(`Failed to initialize analyzer registry: ${JSON.stringify(registryResult.diagnostics)}`);
  }

  try {
    await prepareCommittedIndexedRepo(seqMainRoot, registry);
    await prepareCommittedIndexedRepo(concMainRoot, registry);

    gitExec(seqMainRoot, ["worktree", "add", "-q", "-b", "wt-agent", seqWtRoot, "HEAD"]);
    gitExec(concMainRoot, ["worktree", "add", "-q", "-b", "wt-agent", concWtRoot, "HEAD"]);

    const clock = () => new Date("2026-10-27T00:00:00.000Z");
    const runWorktreeAgent = async (worktreeRoot, label) => {
      const proposeRes = await createDecisionService({ root: worktreeRoot, clock }).propose(
        { kind: "agent", name: `agent-${label}` },
        {
          title: `Worktree proposal ${label}`,
          question: `wt_question_${label}`,
          answer: `wt_answer_${label}`,
          governs: { requirements: ["AUTH-01"] },
        },
      );
      if (!proposeRes.value) {
        return {
          ok: false,
          codes: proposeRes.diagnostics.map((d) => d.code),
          error: proposeRes.diagnostics.map((d) => d.message).join("; "),
        };
      }

      const storeResult = openProjectGraphStore(worktreeRoot);
      if (!storeResult.value) {
        return {
          ok: false,
          codes: storeResult.diagnostics.map((d) => d.code),
          error: storeResult.diagnostics.map((d) => d.message).join("; "),
        };
      }
      const store = storeResult.value;
      try {
        const idx = await indexRepository(worktreeRoot, { store, registry });
        if (!idx.value) {
          return {
            ok: false,
            codes: idx.diagnostics.map((d) => d.code),
            error: idx.diagnostics.map((d) => d.message).join("; "),
          };
        }
      } finally {
        store.close();
      }

      const ctxRes = await projectContext(worktreeRoot, { task: "AUTH-01 src/handler.ts" }, { registry });
      return {
        ok: ctxRes.kind === "ok" && ctxRes.payload.status === "ready",
        codes: ctxRes.diagnostics.map((d) => d.code),
        error:
          ctxRes.diagnostics.map((d) => d.message).join("; ") ||
          (ctxRes.kind === "ok" ? `context status=${ctxRes.payload.status}` : "context failed"),
      };
    };

    // Sequential baseline across main worktree then linked worktree
    const seqMainOutcome = await runWorktreeAgent(seqMainRoot, "main");
    const seqWtOutcome = await runWorktreeAgent(seqWtRoot, "linked");
    if (!seqMainOutcome.ok || !seqWtOutcome.ok) {
      throw new Error(`Sequential C5 worktree baseline failed: ${seqMainOutcome.error || seqWtOutcome.error}`);
    }

    // Concurrent execution across main worktree and linked worktree
    const outcomes = await Promise.all([
      runWorktreeAgent(concMainRoot, "main"),
      runWorktreeAgent(concWtRoot, "linked"),
    ]);

    const mainOracle = evaluateConcurrencyOracle({
      scenario: "C5:concurrent-git-worktrees(main)",
      baselineSnapshot: captureRepoSnapshot(seqMainRoot),
      concurrentSnapshot: captureRepoSnapshot(concMainRoot),
      outcomes: [outcomes[0]],
      checkTruthEquivalence: true,
      checkGraphEquivalence: true,
    });
    const linkedOracle = evaluateConcurrencyOracle({
      scenario: "C5:concurrent-git-worktrees(linked)",
      baselineSnapshot: captureRepoSnapshot(seqWtRoot),
      concurrentSnapshot: captureRepoSnapshot(concWtRoot),
      outcomes: [outcomes[1]],
      checkTruthEquivalence: true,
      checkGraphEquivalence: true,
    });

    const combinedSilentReasons = [...mainOracle.silentReasons, ...linkedOracle.silentReasons];
    const combinedCodes = [...new Set([...mainOracle.explicitErrorCodes, ...linkedOracle.explicitErrorCodes])].sort();
    return {
      scenario: "C5:concurrent-git-worktrees",
      classification:
        combinedSilentReasons.length > 0
          ? "silent-inconsistency"
          : combinedCodes.length > 0
            ? "explicit-error"
            : "safe",
      totalWorkers: 2,
      succeededCount: outcomes.filter((o) => o.ok).length,
      failedCount: outcomes.filter((o) => !o.ok).length,
      explicitErrorCodes: combinedCodes,
      silentReasons: combinedSilentReasons,
      equivalence: {
        decisionsEqual: mainOracle.equivalence.decisionsEqual && linkedOracle.equivalence.decisionsEqual,
        proposalsEqual: mainOracle.equivalence.proposalsEqual && linkedOracle.equivalence.proposalsEqual,
        graphNodesEqual: mainOracle.equivalence.graphNodesEqual && linkedOracle.equivalence.graphNodesEqual,
        graphEdgesEqual: mainOracle.equivalence.graphEdgesEqual && linkedOracle.equivalence.graphEdgesEqual,
        workTasksEqual: true,
      },
    };
  } finally {
    registry.dispose();
    for (const [mainRoot, wtRoot] of [
      [seqMainRoot, seqWtRoot],
      [concMainRoot, concWtRoot],
    ]) {
      try {
        if (fs.existsSync(wtRoot)) {
          gitExec(mainRoot, ["worktree", "remove", "--force", wtRoot]);
        }
      } catch {
        // Fallback directory removal below handles any lingering worktree files
      }
      fs.rmSync(wtRoot, { recursive: true, force: true });
      fs.rmSync(mainRoot, { recursive: true, force: true });
    }
  }
}
