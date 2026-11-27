/**
 * #151 Stage B (Maintainer decision https://github.com/kanghyunsoon/duo/issues/151#issuecomment-6731187696): the
 * tsconfig.json/jsconfig.json candidates the TypeScript resolver probed and found absent are recorded in index-state v5
 * (absentConfigs). A recorded absent candidate that now exists makes the index stale without any source change, so
 * status, inspection and MCP stop reporting current for an ignored config created after an index. present -> absent is
 * the existing configs hash check. A v4 state is incompatible: one explicit duoctl index rebuilds it; the safe MCP
 * refresh keeps refusing that full rebuild with the reason.
 *
 * Out of scope (known limitation): an extends target that is missing is not recorded.
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalyzerRegistry } from "@duo-director/analyzer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dumpGraph } from "../check.js";
import { indexRepository, openProjectGraphReader, openProjectGraphStore } from "./indexer.js";
import { inspectIndex } from "./inspect.js";
import { refreshIndexIfSafe } from "./refresh.js";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, INDEX_STATE_VERSION, readIndexState } from "./state.js";
import { baseRegistry, cleanRebuild, edge, makeRepo, type TestRepo } from "./testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WINDOW = 6;
const temps: string[] = [];
let registry: AnalyzerRegistry;
beforeAll(async () => { registry = await baseRegistry(); });
afterAll(() => { registry?.dispose(); temps.forEach((t) => fs.rmSync(t, { recursive: true, force: true })); });

const CONFIG_TEXT = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } });

function setup(ignored: readonly string[] = ["tsconfig.json"]): TestRepo {
  return makeRepo(temps, {
    ".duo-project/project.yaml": "schema_version: 1\nname: issue151b\n",
    ".gitignore": [".duo-project/generated/", ".duo-project/cache/", ".duo-project/runtime/", ...ignored, ""].join("\n"),
    "src/a.ts": "import { x } from '@lib/x';\nexport const a = x;\n",
    "src/lib/x.ts": "export const x = 1;\n",
  });
}

async function index(r: TestRepo) {
  const opened = openProjectGraphStore(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const result = await indexRepository(r.root, { store: opened.value, registry, historyWindow: WINDOW });
    if (result.value === undefined) throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
  } finally { opened.value.close(); }
}
async function inspect(r: TestRepo) {
  const opened = openProjectGraphReader(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    const result = await inspectIndex(r.root, { graph: opened.value, registry, historyWindow: WINDOW });
    if (result.value === undefined) throw new Error(JSON.stringify(result.diagnostics));
    return result.value;
  } finally { opened.value.close(); }
}
/** The graph equals a clean full rebuild, and graph.db carries the token of the state on disk. */
async function expectConsistent(r: TestRepo) {
  const opened = openProjectGraphReader(r.root);
  if (opened.value === undefined) throw new Error(JSON.stringify(opened.diagnostics));
  try {
    expect(dumpGraph(opened.value as never)).toEqual(await cleanRebuild(r.root, registry, WINDOW));
    expect(opened.value.readMeta(INDEX_STATE_TOKEN_KEY)).toBe(readIndexState(r.root).state?.token);
  } finally { opened.value.close(); }
}
const imports = (r: TestRepo) => {
  const opened = openProjectGraphReader(r.root);
  try { return edge(opened.value as never, "file:src/a.ts", "IMPORTS", "file:src/lib/x.ts") !== undefined; } finally { opened.value?.close(); }
};
/** Rewrites the state file with another version (an older or a newer DUO wrote it). */
function rewriteStateVersion(r: TestRepo, version: number, drop: readonly string[] = []) {
  const state = JSON.parse(r.read(INDEX_STATE_FILE_PATH)) as Record<string, unknown>;
  for (const key of drop) delete state[key];
  r.write(INDEX_STATE_FILE_PATH, `${JSON.stringify({ ...state, version })}\n`);
}

describe("#151 Stage B: absent resolver config candidates in index-state v5", () => {
  it("records the probed absent candidates in UTF-8 order, and a rerun writes nothing", async () => {
    const r = setup();
    await index(r);
    const state = readIndexState(r.root).state as unknown as { version: number; absentConfigs: string[] };
    expect(state.version).toBe(5);
    expect(state.absentConfigs).toEqual(["jsconfig.json", "src/jsconfig.json", "src/lib/jsconfig.json", "src/lib/tsconfig.json", "src/tsconfig.json", "tsconfig.json"]);
    const again = await index(r);
    expect(again.metrics.graph.written).toBe(false);
    expect((await inspect(r)).status).toBe("current");
  });

  it("1, 2: an ignored config created after an index makes status stale with no source change", async () => {
    const r = setup();
    await index(r);
    expect((await inspect(r)).status).toBe("current");
    r.write("tsconfig.json", CONFIG_TEXT);
    const status = await inspect(r);
    expect(status.status).toBe("stale");
    expect(status.configs.changed).toContain("tsconfig.json");
    expect(status.freshness.find((f) => f.path === "src/a.ts")).toMatchObject({ file: "fresh", analysis: "fresh", modules: "stale-config" });
  });

  it("3, 9: one incremental index then equals a clean full rebuild, with the graph token of the state, and is current", async () => {
    const r = setup();
    await index(r);
    r.write("tsconfig.json", CONFIG_TEXT);
    const result = await index(r);
    expect(result.mode).toBe("incremental");
    expect(result.metrics.files.analyzed).toBe(0);
    expect(imports(r)).toBe(true);
    await expectConsistent(r);
    expect((await inspect(r)).status).toBe("current");
    expect((readIndexState(r.root).state as unknown as { absentConfigs: string[] }).absentConfigs).not.toContain("tsconfig.json");
  });

  it("4: deleting the recorded config makes status stale, and the index drops the edge", async () => {
    const r = setup();
    r.write("tsconfig.json", CONFIG_TEXT);
    await index(r);
    expect(imports(r)).toBe(true);
    r.remove("tsconfig.json");
    const status = await inspect(r);
    expect(status.status).toBe("stale");
    expect(status.configs.changed).toContain("tsconfig.json");
    await index(r);
    expect(imports(r)).toBe(false);
    await expectConsistent(r);
    expect((readIndexState(r.root).state as unknown as { absentConfigs: string[] }).absentConfigs).toContain("tsconfig.json");
  });

  it("a nested ignored jsconfig.json created after an index is detected for the files under it", async () => {
    const r = setup(["jsconfig.json", "src/jsconfig.json"]);
    await index(r);
    r.write("src/jsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }));
    const status = await inspect(r);
    expect(status.status).toBe("stale");
    expect(status.configs.changed).toEqual(["src/jsconfig.json"]);
    await index(r);
    expect(imports(r)).toBe(true);
    await expectConsistent(r);
  });

  it("5: a v4 state is incompatible; the safe refresh refuses the full rebuild with the reason; one explicit index makes it current", async () => {
    const r = setup();
    await index(r);
    rewriteStateVersion(r, 4, ["absentConfigs"]);
    const before = r.read(INDEX_STATE_FILE_PATH);
    const status = await inspect(r);
    expect(status.status).toBe("incompatible");
    expect(status.fullRebuildReason).toBe("state-unsupported");
    const refreshed = await refreshIndexIfSafe(r.root, { registry, historyWindow: WINDOW });
    expect(refreshed.value).toBeUndefined();
    expect(refreshed.diagnostics[0]?.message).toContain("requires an existing compatible index (incompatible); run duoctl index explicitly");
    expect(r.read(INDEX_STATE_FILE_PATH)).toBe(before); // a refused refresh writes nothing
    const result = await index(r);
    expect(result.mode).toBe("full");
    expect(result.fullRebuildReason).toBe("state-unsupported");
    expect(readIndexState(r.root).state?.version).toBe(INDEX_STATE_VERSION);
    expect((await inspect(r)).status).toBe("current");
    await expectConsistent(r);
  });

  it("6: a state from a newer DUO is incompatible to this one and is rebuilt, never read (the path an older DUO takes for v5)", async () => {
    const r = setup();
    await index(r);
    rewriteStateVersion(r, INDEX_STATE_VERSION + 1);
    expect((await inspect(r)).status).toBe("incompatible");
    expect((await refreshIndexIfSafe(r.root, { registry, historyWindow: WINDOW })).value).toBeUndefined();
    const result = await index(r);
    expect(result.fullRebuildReason).toBe("state-unsupported");
    expect((await inspect(r)).status).toBe("current");
    await expectConsistent(r);
  });

  it("8: competing safe refreshes after an ignored config appears refresh once under the lock and end current", async () => {
    const r = setup();
    await index(r);
    r.write("tsconfig.json", CONFIG_TEXT);
    const results = await Promise.all(Array.from({ length: 3 }, () => refreshIndexIfSafe(r.root, { registry, historyWindow: WINDOW, lockTimeoutMs: 60_000 })));
    expect(results.map((x) => x.value?.refreshed).sort()).toEqual([false, false, true]);
    expect(imports(r)).toBe(true);
    expect((await inspect(r)).status).toBe("current");
    await expectConsistent(r);
  });

  it("8: a config created while the safe refresh runs is not reported as a refreshed current index", async () => {
    const r = setup();
    await index(r);
    fs.appendFileSync(path.join(r.root, "src/a.ts"), "// edited\n");
    let created = false;
    const result = await refreshIndexIfSafe(r.root, { registry, historyWindow: WINDOW, onPhase: (phase) => {
      if (phase === "graph-plan" && !created) { created = true; r.write("tsconfig.json", CONFIG_TEXT); }
    } });
    expect(created).toBe(true);
    expect(result.value?.refreshed === true && (await inspect(r)).status === "current").toBe(false);
    expect((await inspect(r)).status).toBe("stale");
  });
});
