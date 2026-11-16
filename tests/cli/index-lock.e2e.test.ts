import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { spawn } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { withGraphWriter } from "@duo-director/integration";
import { FINGERPRINT_FILE_PATH } from "@duo-director/analyzer";
import { INDEX_STATE_FILE_PATH, INDEX_STATE_TOKEN_KEY, indexRepository, openProjectGraphReader, withIndexWriteLock } from "@duo-director/graph";
import { baseRegistry, makeRepo } from "../../packages/graph/src/incremental/testing.js";
import { withWriter } from "../../apps/cli/src/commands/shared.js";
import { CLI_MAIN, duoctl } from "./support.js";

const temps: string[] = [];
afterAll(() => temps.forEach((p) => fs.rmSync(p, { recursive: true, force: true })));
/** True when another holder (in this process or another) has the index write lock right now. */
const held = async (root: string) => (await withIndexWriteLock(root, async () => true, { lockTimeoutMs: 0 })).value !== true;

it("CLI index/init and context/review --refresh writers share the lock through DB open and sidecar writes", async () => {
  const r = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: cli-lock\n", "src/a.ts": "export const a = 1;\n" });
  const registry = await baseRegistry();
  let active = 0;
  let maximum = 0;
  const phases: string[] = [];
  try {
    // Indexing through the CLI wrapper must reuse its explicit lease instead of deadlocking.
    await withWriter(r.root, async (store) => {
      const checks: Promise<boolean>[] = [];
      const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "write") checks.push(held(r.root));
      } });
      expect(result.value).toBeDefined();
      expect(await Promise.all(checks)).toEqual([true]);
    });
    const run = (writer: typeof withWriter, label: string) => writer(r.root, async (store) => {
      active++;
      maximum = Math.max(maximum, active);
      phases.push(label);
      expect(await held(r.root)).toBe(true);
      try {
        expect(store.counts().nodes).toBeGreaterThan(0);
        await setTimeout(50);
      } finally { active--; }
    });
    await Promise.all([run(withWriter, "index/init"), run(withGraphWriter, "context/review --refresh")]);
    expect(maximum).toBe(1);
    expect(phases).toHaveLength(2);
    expect(await held(r.root)).toBe(false);
  } finally { registry.dispose(); }
}, 120_000);

it("independent Node processes refresh the same stale index exactly once", async () => {
  const r = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: process-lock\n", "src/a.ts": "export const a = 1;\n" });
  const registry = await baseRegistry();
  try {
    await withWriter(r.root, async (store) => {
      expect((await indexRepository(r.root, { store, registry })).value).toBeDefined();
    });
  } finally { registry.dispose(); }
  r.git("commit", "--allow-empty", "-qm", "stale for multiple processes");
  const moduleUrl = new URL("../../packages/graph/dist/index.js", import.meta.url).href;
  const source = `import { refreshIndexIfSafe } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await refreshIndexIfSafe(process.argv[1], { lockTimeoutMs: 60000 })));`;
  const run = () => new Promise<{ value?: { refreshed: boolean }; diagnostics: unknown[] }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, r.root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr)); return; }
      try { resolve(JSON.parse(stdout) as { value?: { refreshed: boolean }; diagnostics: unknown[] }); } catch (error) { reject(error); }
    });
  });
  const completed = await Promise.allSettled(Array.from({ length: 4 }, run));
  expect(completed.every((result) => result.status === "fulfilled")).toBe(true);
  const results = completed.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  expect(results.map((result) => result.value?.refreshed).sort()).toEqual([false, false, false, true]);
  expect(await held(r.root)).toBe(false);
}, 120_000);

it("a killed duoctl index leaves no lock behind: the next index runs and the index state is consistent (T180)", async () => {
  const files: Record<string, string> = { ".duo-project/project.yaml": "schema_version: 1\nname: crash\n" };
  for (let i = 0; i < 300; i++) {
    files[`src/m${i}.ts`] = (i > 0 ? `import { f${i - 1} } from "./m${i - 1}";\n` : "") + `export function f${i}(): number { return ${i > 0 ? `f${i - 1}() + ` : ""}${i}; }\n`;
  }
  const r = makeRepo(temps, files);
  const child = spawn(process.execPath, [CLI_MAIN, "index", "--full"], { cwd: r.root, windowsHide: true, stdio: "ignore" });
  const started = Date.now();
  while (!(await held(r.root)) && child.exitCode === null && Date.now() - started < 60_000) await setTimeout(5);
  expect(child.exitCode).toBeNull(); // killed while it holds the lock, before it finished
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  expect(await held(r.root)).toBe(false);
  const next = duoctl(r.root, ["index"]);
  expect(next.code, next.stdout + next.stderr).toBe(0);
  const state = JSON.parse(fs.readFileSync(path.join(r.root, INDEX_STATE_FILE_PATH), "utf8")) as { token: string; files: { path: string; contentHash: string }[] };
  const graph = openProjectGraphReader(r.root).value!;
  try { expect(graph.readMeta(INDEX_STATE_TOKEN_KEY)).toBe(state.token); } finally { graph.close(); }
  const fingerprints = JSON.parse(fs.readFileSync(path.join(r.root, FINGERPRINT_FILE_PATH), "utf8")) as { files: { path: string; contentHash: string }[] };
  expect(fingerprints.files.map((f) => [f.path, f.contentHash])).toEqual(state.files.map((f) => [f.path, f.contentHash]));
}, 120_000);
