import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { ANALYSIS_CACHE_DIR } from "./analysis-cache.js";
import { indexRepository, type IndexOptions } from "./indexer.js";
import { INDEX_STATE_FILE_PATH } from "./state.js";
import { baseRegistry, cleanRebuild, countingRegistry, invariantProblems, makeRepo, memoryStore, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WINDOW = 6;
const temps: string[] = [];
let base: AnalyzerRegistry;
let repo: TestRepo;
let store: GraphStore;
beforeAll(async () => {
  base = await baseRegistry();
  repo = makeRepo(temps);
  store = memoryStore();
});
afterAll(() => {
  store?.close();
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

const statePath = () => path.join(repo.root, INDEX_STATE_FILE_PATH);
/** Runs the Indexer, then checks it against a clean rebuild (with its own registry so parse counts stay the Indexer's). */
async function run(options: Partial<IndexOptions> = {}, registry: AnalyzerRegistry = base, oracle: AnalyzerRegistry = registry) {
  const r = await indexRepository(repo.root, { store, registry, historyWindow: WINDOW, ...options });
  if (r.value !== undefined) {
    expect(dumpGraph(options.store ?? store)).toEqual(await cleanRebuild(repo.root, oracle, WINDOW));
    expect(invariantProblems(options.store ?? store, repo.root)).toEqual([]);
  }
  return r;
}

describe("recovery: any doubt about the state means a full rebuild", () => {
  it("writes the state, the fingerprint file and one analysis cache entry per analyzed file", async () => {
    const r = await run();
    expect(r.value).toMatchObject({ mode: "full", fullRebuildReason: "no-state" });
    expect(fs.existsSync(statePath())).toBe(true);
    expect(fs.existsSync(path.join(repo.root, ".duo-project/generated/fingerprints.json"))).toBe(true);
    expect(fs.readdirSync(path.join(repo.root, ANALYSIS_CACHE_DIR))).toHaveLength(r.value?.metrics.files.analyzed ?? -1);
    expect(store.readMeta("index_state_token")).toBe(JSON.parse(fs.readFileSync(statePath(), "utf8")).token);
  });

  it("corrupt state", async () => {
    fs.writeFileSync(statePath(), "{ not json");
    const r = await run();
    expect(r.value).toMatchObject({ mode: "full", fullRebuildReason: "state-invalid" });
    expect(r.diagnostics.map((d) => d.code)).toContain("INDEX_STATE_INVALID");
  });

  it("unsupported state version", async () => {
    const state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    fs.writeFileSync(statePath(), JSON.stringify({ ...state, version: 99 }));
    expect((await run()).value).toMatchObject({ mode: "full", fullRebuildReason: "state-unsupported" });
  });

  it("state edited by hand (content no longer matches its token)", async () => {
    const state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    state.files[0].size += 1;
    fs.writeFileSync(statePath(), JSON.stringify(state));
    expect((await run()).value).toMatchObject({ mode: "full", fullRebuildReason: "state-invalid" });
  });

  it("crash after the graph commit and before the state write (token mismatch)", async () => {
    const old = fs.readFileSync(statePath(), "utf8");
    repo.edit("src/util/index.ts", "export function util(): void {}", "export function util(): void {\n  return;\n}");
    expect((await run()).value?.mode).toBe("incremental");
    fs.writeFileSync(statePath(), old); // the state file of the previous run survived, the graph moved on
    expect((await run()).value).toMatchObject({ mode: "full", fullRebuildReason: "state-mismatch" });
  });

  it("a failed graph transaction writes neither graph nor state; the next run catches up", async () => {
    const stateBefore = fs.readFileSync(statePath(), "utf8");
    const graphBefore = dumpGraph(store);
    repo.edit("src/shared/format.ts", "return String(n);", "return String(n + 1);");
    const failing = new Proxy(store, {
      get(target, prop) {
        if (prop === "transaction") {
          return (fn: Parameters<GraphStore["transaction"]>[0]) => target.transaction((tx) => {
            fn(tx);
            throw new Error("simulated disk failure");
          });
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const r = await indexRepository(repo.root, { store: failing, registry: base, historyWindow: WINDOW });
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toContain("GRAPH_WRITE_REFUSED");
    expect(fs.readFileSync(statePath(), "utf8")).toBe(stateBefore);
    expect(dumpGraph(store)).toEqual(graphBefore);
    expect((await run()).value?.mode).toBe("incremental");
  });

  it("an analyzer version change re-analyzes that analyzer's files only", async () => {
    const bumped = countingRegistry(base, "999-test");
    const r = await run({}, bumped.registry, countingRegistry(base, "999-test").registry);
    expect(r.value?.mode).toBe("incremental");
    expect(new Set(r.value?.freshness.filter((f) => f.analysis !== undefined).map((f) => f.analysis))).toEqual(new Set(["stale-analyzer"]));
    expect(bumped.parses).toBe(r.value?.metrics.files.analyzed);
    const back = await run();
    expect(back.value?.metrics.files.analysisReused).toBe(0);
  });

  it("a lost analysis cache entry is a cache miss, not a wrong result", async () => {
    const dir = path.join(repo.root, ANALYSIS_CACHE_DIR);
    const [first] = fs.readdirSync(dir);
    fs.rmSync(path.join(dir, first ?? "none"));
    const counting = countingRegistry(base);
    const r = await run({}, counting.registry, base);
    expect(r.value?.mode).toBe("incremental");
    expect(counting.parses).toBe(1);
    expect(r.value?.freshness.filter((f) => f.analysis === "missing")).toHaveLength(1);
  });

  it("a requested full rebuild ignores the state", async () => {
    expect((await run({ full: true })).value).toMatchObject({ mode: "full", fullRebuildReason: "requested" });
  });
});

