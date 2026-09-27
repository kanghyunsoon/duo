import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import type { GraphStore } from "../store/types.js";
import { indexRepository, openProjectGraphStore } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { INDEX_STATE_FILE_PATH } from "./state.js";
import { baseRegistry, makeRepo, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WINDOW = 6;
const temps: string[] = [];
let base: AnalyzerRegistry;
let repo: TestRepo;
beforeAll(async () => {
  base = await baseRegistry();
  repo = makeRepo(temps);
});
afterAll(() => {
  base?.dispose();
  temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true }));
});

function openGraph(): GraphStore {
  const opened = openProjectGraphStore(repo.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  return opened.value;
}

/** sha256 of every file in the work tree except .git (graph.db, state, fingerprints, analysis cache and sources included). */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(abs);
      } else out[path.relative(repo.root, abs).replace(/\\/g, "/")] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  };
  walk(repo.root);
  return out;
}

async function index() {
  const store = openGraph();
  try {
    const r = await indexRepository(repo.root, { store, registry: base, historyWindow: WINDOW });
    if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
    return r.value;
  } finally {
    store.close();
  }
}

/** Inspects with the graph open, then closes it; checks that neither the files nor the graph changed. */
async function inspectWithoutWrites() {
  const before = snapshot();
  const store = openGraph();
  const graphBefore = dumpGraph(store);
  const meta = [store.readMeta("graph_revision"), store.readMeta("index_state_token")];
  try {
    const r = await inspectIndex(repo.root, { graph: store, registry: base, historyWindow: WINDOW });
    if (r.value === undefined) throw new Error(JSON.stringify(r.diagnostics));
    expect(dumpGraph(store)).toEqual(graphBefore);
    expect([store.readMeta("graph_revision"), store.readMeta("index_state_token")]).toEqual(meta);
    return r.value;
  } finally {
    store.close();
    expect(snapshot()).toEqual(before);
  }
}

describe("inspectIndex(): read-only freshness (T08.1)", () => {
  it("reports a missing index and writes nothing", async () => {
    openGraph().close(); // an empty graph database exists; creating it is not part of inspect
    const r = await inspectWithoutWrites();
    expect(r).toMatchObject({ status: "missing", fullRebuildReason: "no-state", wouldRebuild: { full: true } });
  });

  it("an index that a run would not touch is current", async () => {
    await index();
    const r = await inspectWithoutWrites();
    expect(r.status).toBe("current");
    expect(r.wouldRebuild).toEqual({ full: false, parse: [], modules: [], predictedCalls: [], history: false, projectTruth: false });
    const again = await index();
    expect(again.metrics.graph.written).toBe(false);
  });

  it("predicts what the next run recomputes, without doing it", async () => {
    repo.edit("src/shared/format.ts", "return String(n);", "return String(n).trim();");
    repo.edit(".duo-project/specs/app.md", "Users log in.", "Users log in with a password.");
    const r = await inspectWithoutWrites();
    expect(r.status).toBe("stale");
    expect(r.wouldRebuild).toMatchObject({ full: false, parse: ["src/shared/format.ts"], modules: ["src/shared/format.ts"], history: false, projectTruth: true });
    expect(r.projectTruth.changed).toEqual([".duo-project/specs/app.md"]);
    const run = await index();
    expect(run.mode).toBe("incremental");
    // File, analysis and module freshness are the Indexer's own decisions; calls are an upper bound.
    const strip = (records: typeof r.freshness) => records.map((f) => ({ path: f.path, file: f.file, analysis: f.analysis, modules: f.modules }));
    expect(strip(r.freshness)).toEqual(strip(run.freshness));
    const recomputed = run.freshness.filter((f) => f.calls !== undefined && f.calls !== "fresh").map((f) => f.path);
    for (const p of recomputed) expect(r.wouldRebuild.predictedCalls).toContain(p);
    expect(run.metrics.files.analyzed).toBe(r.wouldRebuild.parse.length);
  });

  it("sees config, history and branch changes", async () => {
    repo.edit("tsconfig.json", '"./src/shared/*"', '"./src/shared/*", "./src/other/*"');
    let r = await inspectWithoutWrites();
    expect(r.configs.changed).toEqual(["tsconfig.json"]);
    expect(r.freshness.find((f) => f.path === "src/app.ts")).toMatchObject({ analysis: "fresh", modules: "stale-config" });
    await index();
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "APP-10 status");
    r = await inspectWithoutWrites();
    expect(r).toMatchObject({ status: "stale", wouldRebuild: { history: true, parse: [] } });
    await index();
    repo.git("checkout", "-q", "-b", "feature/APP-10-other");
    r = await inspectWithoutWrites();
    expect(r.status).toBe("stale"); // same commit, new branch: the Project node changes
    const run = await index();
    expect(run.metrics.graph.written).toBe(true);
    expect((await inspectWithoutWrites()).status).toBe("current");
  });

  it("an untrusted state is incompatible", async () => {
    fs.writeFileSync(path.join(repo.root, INDEX_STATE_FILE_PATH), "{ broken");
    const r = await inspectWithoutWrites();
    expect(r).toMatchObject({ status: "incompatible", fullRebuildReason: "state-invalid", wouldRebuild: { full: true } });
  });
});

