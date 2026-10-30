import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { FINGERPRINT_FILE_PATH } from "@duo-director/analyzer";
import { indexRepository, openProjectGraphStore } from "./indexer.js";
import { refreshIndexIfSafe } from "./refresh.js";
import { INDEX_WRITE_LOCK_PATH, withIndexWriteLock } from "./write-lock.js";
import { baseRegistry, makeRepo } from "./testing.js";

const temps: string[] = [];
afterAll(() => temps.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const released = async (root: string) => (await withIndexWriteLock(root, async () => true, { lockTimeoutMs: 0 })).value === true;
/** Windows without Developer Mode cannot create symlinks (EPERM); the case runs on the other OSes. */
const symlinks = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duo-symlink-probe-"));
  temps.push(dir);
  try { fs.symlinkSync(path.join(dir, "absent"), path.join(dir, "link"), "file"); return true; } catch { return false; }
})();
for (const entry of [INDEX_WRITE_LOCK_PATH, `${INDEX_WRITE_LOCK_PATH}-journal`]) {
  it.runIf(symlinks)(`refuses a dangling symlink at ${entry} and creates nothing outside the worktree (#148 review)`, async () => {
    const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: link\n", "src/a.ts": "export const a = 1;\n" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "duo-outside-"));
    temps.push(outside);
    const target = path.join(outside, "created-by-lock");
    fs.mkdirSync(path.dirname(path.join(repo.root, INDEX_WRITE_LOCK_PATH)), { recursive: true });
    fs.symlinkSync(target, path.join(repo.root, entry), "file");
    const result = await withIndexWriteLock(repo.root, async () => "unreachable", { lockTimeoutMs: 0 });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "GRAPH_WRITE_REFUSED", message: expect.stringContaining("symlink") });
    expect(fs.existsSync(target)).toBe(false);
  });
}
it("holds the lock without a journal file next to it (#148 review)", async () => {
  const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: journal\n", "src/a.ts": "export const a = 1;\n" });
  const seen = await withIndexWriteLock(repo.root, async () => fs.readdirSync(path.dirname(path.join(repo.root, INDEX_WRITE_LOCK_PATH))));
  expect(seen.value).toContain("index-writer.lock");
  expect(seen.value).not.toContain("index-writer.lock-journal");
  expect(await released(repo.root)).toBe(true);
});
it("converts a source deletion during analysis to a recovery refusal and releases the lock", async () => {
  const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: error\n", "src/a.ts": "export const a = 1;\n" });
  const registry = await baseRegistry();
  const store = openProjectGraphStore(repo.root).value!;
  try { expect((await indexRepository(repo.root, { store, registry })).value).toBeDefined(); } finally { store.close(); }
  try {
    repo.write("src/a.ts", "export const a = 2;\n");
    let registries = 0;
    const result = await refreshIndexIfSafe(repo.root, { registry, onPhase: (phase) => {
      if (phase === "registry" && ++registries === 2) repo.remove("src/a.ts");
    } });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("GRAPH_WRITE_REFUSED");
    expect(result.diagnostics[0]?.message).toContain("Safe index refresh failed:");
    expect(await released(repo.root)).toBe(true);
  } finally { registry.dispose(); }
}, 120_000);

for (const automatic of [false, true]) {
  it(`${automatic ? "automatic recovery refuses" : "explicit index preserves its warning for"} a fingerprint write failure`, async () => {
    const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: sidecar\n", "src/a.ts": "export const a = 1;\n" });
    const registry = await baseRegistry();
    const store = openProjectGraphStore(repo.root).value!;
    try {
      expect((await indexRepository(repo.root, { store, registry })).value).toBeDefined();
      const target = path.join(repo.root, FINGERPRINT_FILE_PATH);
      fs.rmSync(target);
      fs.mkdirSync(target); // the atomic fingerprint-file rename must fail
      repo.write("src/a.ts", "export const a = 2;\n");
      const result = automatic
        ? await refreshIndexIfSafe(repo.root, { registry })
        : await indexRepository(repo.root, { store, registry });
      expect(result.value === undefined).toBe(automatic);
      expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FILE_WRITE_ERROR", severity: automatic ? "error" : "warning" })]));
      expect(await released(repo.root)).toBe(true);
    } finally { store.close(); registry.dispose(); }
  }, 120_000);
}
