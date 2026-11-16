/**
 * MCP server failure and recovery E2E investigation suite (Jira S15P31A106-273).
 *
 * Verifies deterministic failure handling and recovery across four fault categories on a real
 * `duoctl mcp` stdio server process without LLM calls:
 *   O1 (F1) - Project Truth YAML corruption and in-place recovery without server restart
 *   O2 (F2) - SQLite graph.db corruption and auxiliary runtime/metrics.jsonl + work-tasks.lock fault isolation
 *   O3 (F3) - Server-side lock-wait cancellation (#172/#198) and in-session recovery
 *   O4 (F4) - Graceful shutdown vs abrupt server crash, CLI fallback parity, and fresh MCP reconnect
 */
import fs from "node:fs";
import path from "node:path";
import { createDecisionService } from "@duo-director/core";
import { withIndexWriteLock } from "@duo-director/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { duoctl, existingProject } from "../cli/support.js";
import { startMcp, type McpSession } from "./support.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const temps: string[] = [];
const sessions: McpSession[] = [];

afterAll(async () => {
  for (const s of sessions) {
    await s.close().catch(() => undefined);
  }
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore transient Windows cleanup lock on temp directory
    }
  }
});

const open = async (root: string): Promise<McpSession> => {
  const s = await startMcp(root);
  sessions.push(s);
  return s;
};

describe("MCP server failure and recovery E2E (Jira S15P31A106-273)", () => {
  const p = existingProject(temps);
  let s: McpSession;
  let decisionFile = "";
  let validDecisionYaml = "";
  let projectFile = "";
  let validProjectYaml = "";

  beforeAll(async () => {
    const init = duoctl(
      p.root,
      ["init", "--non-interactive", "--answers", "-", "--json"],
      JSON.stringify([{ question: "project_goal", value: "Keep recurring chores fair." }]),
    );
    expect(init.code, init.stderr).toBe(0);

    const ds = createDecisionService({ root: p.root });
    const prop = await ds.propose(
      { kind: "agent", name: "codex" },
      {
        title: "Weekday rotation",
        question: "Should the rotation skip weekends?",
        answer: "Yes, weekdays only.",
        governs: { paths: ["src/scheduler.ts"] },
      },
    );
    expect(prop.value?.proposalId).toBe("P-001");
    const conf = await ds.confirm({ kind: "human", name: "Maintainer" }, "P-001");
    expect(conf.value?.decisionId).toBe("D-001");
    expect(duoctl(p.root, ["index", "--json"]).code).toBe(0);

    decisionFile = path.join(p.root, ".duo-project", "decisions", "D-001.yaml");
    validDecisionYaml = fs.readFileSync(decisionFile, "utf8");
    projectFile = path.join(p.root, ".duo-project", "project.yaml");
    validProjectYaml = fs.readFileSync(projectFile, "utf8");

    s = await open(p.root);
  });

  it("O1 (F1): survives malformed Project Truth YAML and recovers in-place on the next call without restarting the MCP server", async () => {
    const pidBefore = s.pid;
    expect(pidBefore).toBeTypeOf("number");

    // 1. Corrupt D-001.yaml while the MCP server is running:
    // - duo_get_status stays readable (T40 N1) and reports the broken file under truth.errors (YAML_SYNTAX_ERROR)
    // - duo_get_context and duo_review_changes see the stale Truth file, attempt refreshIndexIfSafe, and refuse with PROJECT_TRUTH_INVALID in indexRefresh.reason
    // - duo_get_decision omits the unreadable file and returns status: "not-found" until the file is restored
    fs.writeFileSync(decisionFile, "id: D-001\nstate: [unclosed_yaml\n", "utf8");
    try {
      const statusWithBrokenDecision = await s.call("duo_get_status");
      expect(statusWithBrokenDecision.isError).toBeFalsy();
      expect(statusWithBrokenDecision.structuredContent.truth.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "YAML_SYNTAX_ERROR",
            path: ".duo-project/decisions/D-001.yaml",
          }),
        ]),
      );

      const badCtx = await s.call("duo_get_context", { task: "Scheduler.next" });
      expect(badCtx.isError).toBeFalsy();
      expect(badCtx.structuredContent).toMatchObject({
        format: "duo.context/1",
        status: "index-required",
        indexRefresh: {
          refreshed: false,
          reason: expect.stringMatching(/Project Truth could not be read completely|\.duo-project\/decisions\/D-001\.yaml/u),
        },
      });

      const badRev = await s.call("duo_review_changes", { task: "Scheduler.next" });
      expect(badRev.isError).toBeFalsy();
      expect(badRev.structuredContent).toMatchObject({
        format: "duo.review/1",
        status: "index-required",
        indexRefresh: {
          refreshed: false,
          reason: expect.stringMatching(/Project Truth could not be read completely|\.duo-project\/decisions\/D-001\.yaml/u),
        },
      });

      const badDec = await s.call("duo_get_decision", { id: "D-001" });
      expect(badDec.isError).toBeFalsy();
      expect(badDec.structuredContent).toMatchObject({
        format: "duo.decision/1",
        status: "not-found",
        id: "D-001",
      });
    } finally {
      fs.writeFileSync(decisionFile, validDecisionYaml, "utf8");
    }

    // In-place recovery on the exact same MCP server process (no restart, no re-index required since bytes match)
    expect(s.pid).toBe(pidBefore);
    const recoveredStatus = await s.call("duo_get_status");
    expect(recoveredStatus.isError).toBeFalsy();
    expect(recoveredStatus.structuredContent).toMatchObject({
      format: "duo.status/1",
      initialized: true,
      index: { status: "current" },
      truth: { errors: [] },
    });

    const recoveredDec = await s.call("duo_get_decision", { id: "D-001" });
    expect(recoveredDec.isError).toBeFalsy();
    expect(recoveredDec.structuredContent).toMatchObject({
      format: "duo.decision/1",
      status: "found",
      id: "D-001",
    });

    const recoveredCtx = await s.call("duo_get_context", { task: "Scheduler.next" });
    expect(recoveredCtx.isError).toBeFalsy();
    expect(recoveredCtx.structuredContent).toMatchObject({ format: "duo.context/1", status: "ready" });

    // 2. Corrupt root .duo-project/project.yaml: all tools fail closed with YAML_SYNTAX_ERROR, then recover in-place
    fs.writeFileSync(projectFile, ":::invalid: [yaml\n", "utf8");
    try {
      const badStatus = await s.call("duo_get_status");
      expect(badStatus.isError).toBe(true);
      expect(badStatus.content[0]?.text).toMatch(/YAML_SYNTAX_ERROR|PROJECT_FILE_INVALID/u);

      const badCtxRoot = await s.call("duo_get_context", { task: "Scheduler.next" });
      expect(badCtxRoot.isError).toBe(true);
      expect(badCtxRoot.content[0]?.text).toMatch(/YAML_SYNTAX_ERROR|PROJECT_FILE_INVALID/u);
    } finally {
      fs.writeFileSync(projectFile, validProjectYaml, "utf8");
    }

    const afterProjectFix = await s.call("duo_review_changes", { task: "Scheduler.next" });
    expect(afterProjectFix.isError).toBeFalsy();
    expect(afterProjectFix.structuredContent).toMatchObject({ format: "duo.review/1", status: "ready" });
    expect(s.pid).toBe(pidBefore);
  });

  it("O2 (F2): isolates SQLite graph.db byte corruption and runtime metrics.jsonl/work-tasks.lock faults, recovering in-place after CLI re-index", async () => {
    const pidBefore = s.pid;
    const dbPath = path.join(p.root, ".duo-project", "generated", "graph.db");

    try {
      // 1. Corrupt graph.db with non-SQLite bytes while the MCP server is running
      fs.writeFileSync(dbPath, "corrupt-sqlite-header-bytes", "utf8");
      const corruptStatus = await s.call("duo_get_status");
      const corruptTrace = await s.call("duo_trace", { node: "src/scheduler.ts" });
      expect(corruptTrace.isError || corruptTrace.structuredContent?.status === "index-required").toBe(true);
      if (!corruptStatus.isError) {
        expect(["incompatible", "missing", "stale"]).toContain(corruptStatus.structuredContent?.index?.status);
      }

      // Rebuild index via CLI while the same MCP server stays open
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        fs.rmSync(f, { force: true });
      }
      const rebuilt = duoctl(p.root, ["index", "--full", "--json"]);
      expect(rebuilt.code, rebuilt.stderr).toBe(0);

      // Same MCP server immediately reads the new graph.db on the next tool call
      expect(s.pid).toBe(pidBefore);
      const traceAfterRebuild = await s.call("duo_trace", { node: "src/scheduler.ts" });
      expect(traceAfterRebuild.isError).toBeFalsy();
      expect(traceAfterRebuild.structuredContent).toMatchObject({ format: "duo.trace/1", index: "current" });
    } finally {
      if (!fs.existsSync(dbPath)) {
        duoctl(p.root, ["index", "--full", "--json"]);
      }
    }

    // 2. Auxiliary metrics.jsonl write failure and work-tasks.lock contention do not fail metered MCP tools
    const metricsPath = path.join(p.root, ".duo-project", "runtime", "metrics.jsonl");
    const workLockPath = path.join(p.root, ".duo-project", "runtime", "work-tasks.lock");
    fs.rmSync(metricsPath, { recursive: true, force: true });
    fs.mkdirSync(metricsPath, { recursive: true });
    fs.writeFileSync(workLockPath, "held-by-another-process", "utf8");
    try {
      const ctxDuringMetricFault = await s.call("duo_get_context", { task: "Scheduler.next" });
      expect(ctxDuringMetricFault.isError).toBeFalsy();
      expect(ctxDuringMetricFault.structuredContent.status).toBe("ready");

      const revDuringMetricFault = await s.call("duo_review_changes", { task: "Scheduler.next" });
      expect(revDuringMetricFault.isError).toBeFalsy();
      expect(revDuringMetricFault.structuredContent.status).toBe("ready");
      expect(s.stderr()).toContain("METRICS_WRITE_FAILED");
      expect(s.stderr()).toContain("duo work activity task failed");
    } finally {
      fs.rmSync(metricsPath, { recursive: true, force: true });
      fs.rmSync(workLockPath, { force: true });
    }

    // Next metered call recreates metrics.jsonl cleanly
    const ctxAfterMetricFix = await s.call("duo_get_context", { task: "Scheduler.next" });
    expect(ctxAfterMetricFix.isError).toBeFalsy();
    expect(fs.existsSync(metricsPath)).toBe(true);
  });

  it("O3 (F3): stops server-side index lock wait on request cancellation (#172/#198) and auto-refreshes quickly once the lock is free", async () => {
    const schedulerPath = path.join(p.root, "src", "scheduler.ts");
    const metricsPath = path.join(p.root, ".duo-project", "runtime", "metrics.jsonl");
    const originalScheduler = fs.readFileSync(schedulerPath, "utf8");
    const readMetrics = () =>
      fs.existsSync(metricsPath)
        ? fs
            .readFileSync(metricsPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { command?: string; status?: string; durationMs?: number })
        : [];

    p.edit("src/scheduler.ts", "% 7", "% 5");
    try {
      expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("stale");

      await withIndexWriteLock(p.root, async () => {
        const metricsBefore = readMetrics().length;
        const controller = new AbortController();
        const pending = s.client.callTool(
          { name: "duo_get_context", arguments: { task: "Scheduler.next" } },
          { signal: controller.signal },
        );
        await new Promise((r) => setTimeout(r, 250));
        controller.abort();
        await expect(pending).rejects.toThrow();

        // Server-side verification (#198): while the external writer lock is STILL held, the server must
        // abort its 30 s withIndexWriteLock wait, finish readWithSafeRefresh, and append the runtime metric.
        const waitServerCancelled = async () => {
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            const current = readMetrics();
            if (current.length > metricsBefore) return current[current.length - 1];
            await new Promise((r) => setTimeout(r, 25));
          }
          return undefined;
        };
        const cancelledMetric = await waitServerCancelled();
        expect(cancelledMetric).toMatchObject({
          command: "duo_get_context",
          status: "index-required",
        });
        expect(cancelledMetric?.durationMs).toBeLessThan(5_000);

        // The same MCP connection stays responsive while the writer lock is still held
        const statusWhileLocked = await s.call("duo_get_status");
        expect(statusWhileLocked.isError).toBeFalsy();
        expect(statusWhileLocked.structuredContent.index.status).toBe("stale");
      });

      // After the writer lock is released, no lingering server request steals the lock in the background
      await new Promise((r) => setTimeout(r, 100));
      expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("stale");

      // The first duo_get_context after lock release acquires the free lock immediately and refreshes once
      const tRefresh = performance.now();
      const refreshedCtx = await s.call("duo_get_context", { task: "Scheduler.next" });
      expect(performance.now() - tRefresh).toBeLessThan(5_000);
      expect(refreshedCtx.isError).toBeFalsy();
      expect(refreshedCtx.structuredContent).toMatchObject({
        format: "duo.context/1",
        status: "ready",
        indexRefresh: { refreshed: true },
      });
      expect((await s.call("duo_get_status")).structuredContent.index.status).toBe("current");
    } finally {
      fs.writeFileSync(schedulerPath, originalScheduler, "utf8");
      duoctl(p.root, ["index", "--json"]);
    }
  });

  it("O4 (F4): marks Work-map tasks disconnected on graceful close, supports CLI fallback during server crash, and recovers on fresh MCP reconnect", async () => {
    const workTasksPath = path.join(p.root, ".duo-project", "runtime", "work-tasks.json");

    // 1. Graceful close marks the session's active tasks as disconnected in work-tasks.json
    const sGraceful = await open(p.root);
    const gCtx = await sGraceful.call("duo_get_context", { task: "Graceful session task" });
    expect(gCtx.isError).toBeFalsy();
    await sGraceful.close();

    // Wait briefly for the server process close handler to flush work-tasks.json
    const waitDisconnected = async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          if (fs.existsSync(workTasksPath)) {
            const data = JSON.parse(fs.readFileSync(workTasksPath, "utf8")) as {
              tasks?: { name: string; status: string }[];
            };
            if (data.tasks?.some((t) => t.name === "Graceful session task" && t.status === "disconnected")) {
              return true;
            }
          }
        } catch {
          // retry if work-tasks.json is mid-rename
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    expect(await waitDisconnected()).toBe(true);

    // 2. Abrupt server crash (SIGKILL), file change while server is dead, CLI fallback, and fresh MCP reconnect
    const sCrash = await open(p.root);
    expect((await sCrash.call("duo_get_status")).isError).toBeFalsy();
    const crashPid = sCrash.pid;
    expect(crashPid).toBeTypeOf("number");
    process.kill(crashPid!, "SIGKILL");
    await expect(sCrash.call("duo_get_status")).rejects.toThrow();
    await sCrash.close().catch(() => undefined);

    // Edit source while no MCP server is alive
    p.edit("src/scheduler.ts", "% 7", "% 3");

    // Agent bridge CLI fallback works while MCP is unavailable
    const cliStatus = duoctl(p.root, ["status", "--json"]);
    expect(cliStatus.code).toBe(0);
    expect(cliStatus.json().result.index.status).toBe("stale");

    const cliCtx = duoctl(p.root, ["context", "Scheduler.next", "--refresh", "--json"]);
    expect(cliCtx.code, cliCtx.stderr).toBe(0);
    expect(cliCtx.json().result.status).toBe("ready");

    const cliRev = duoctl(p.root, ["review", "--task", "Scheduler.next", "--json"]);
    expect(cliRev.code, cliRev.stderr).toBe(0);
    expect(cliRev.json().result).toMatchObject({ format: "duo.review/1", status: "ready", verdict: "PASS" });

    // Edit source again and reconnect with a fresh MCP server instance
    p.edit("src/scheduler.ts", "% 3", "% 7");
    const sReconnected = await open(p.root);

    const reconnCtx = await sReconnected.call("duo_get_context", { task: "Scheduler.next" });
    expect(reconnCtx.isError).toBeFalsy();
    expect(reconnCtx.structuredContent).toMatchObject({
      format: "duo.context/1",
      status: "ready",
      indexRefresh: { refreshed: true },
    });

    const reconnRev = await sReconnected.call("duo_review_changes", { task: "Scheduler.next" });
    expect(reconnRev.isError).toBeFalsy();
    const cliRevAfter = duoctl(p.root, ["review", "--task", "Scheduler.next", "--json"]).json().result;
    expect(reconnRev.structuredContent).toEqual(cliRevAfter);
  });
});
