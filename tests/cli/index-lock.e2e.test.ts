import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { spawn } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { withGraphWriter } from "@duo-director/integration";
import { INDEX_WRITE_LOCK_PATH, indexRepository } from "@duo-director/graph";
import { baseRegistry, makeRepo } from "../../packages/graph/src/incremental/testing.js";
import { withWriter } from "../../apps/cli/src/commands/shared.js";

const temps: string[] = [];
afterAll(() => temps.forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

it("CLI index/init and context/review --refresh writers share the lock through DB open and sidecar writes", async () => {
  const r = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: cli-lock\n", "src/a.ts": "export const a = 1;\n" });
  const registry = await baseRegistry();
  let active = 0;
  let maximum = 0;
  const phases: string[] = [];
  try {
    // Indexing through the CLI wrapper must reuse its explicit lease instead of deadlocking.
    await withWriter(r.root, async (store) => {
      const result = await indexRepository(r.root, { store, registry, onPhase: (phase) => {
        if (phase === "write") expect(fs.existsSync(path.join(r.root, INDEX_WRITE_LOCK_PATH))).toBe(true);
      } });
      expect(result.value).toBeDefined();
    });
    const run = (writer: typeof withWriter, label: string) => writer(r.root, async (store) => {
      active++;
      maximum = Math.max(maximum, active);
      phases.push(label);
      expect(fs.existsSync(path.join(r.root, INDEX_WRITE_LOCK_PATH))).toBe(true);
      try {
        expect(store.counts().nodes).toBeGreaterThan(0);
        await setTimeout(50);
      } finally { active--; }
    });
    await Promise.all([run(withWriter, "index/init"), run(withGraphWriter, "context/review --refresh")]);
    expect(maximum).toBe(1);
    expect(phases).toHaveLength(2);
    expect(fs.existsSync(path.join(r.root, INDEX_WRITE_LOCK_PATH))).toBe(false);
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
  expect(fs.existsSync(path.join(r.root, INDEX_WRITE_LOCK_PATH))).toBe(false);
}, 120_000);
