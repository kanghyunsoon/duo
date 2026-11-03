import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { FINGERPRINT_FILE_PATH } from "@duo-director/analyzer";
import { indexRepository, openProjectGraphStore } from "./indexer.js";
import { refreshIndexIfSafe } from "./refresh.js";
import { INDEX_WRITE_LOCK_PATH } from "./write-lock.js";
import { baseRegistry, makeRepo } from "./testing.js";

const temps: string[] = [];
afterAll(() => temps.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
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
    expect(fs.existsSync(path.join(repo.root, INDEX_WRITE_LOCK_PATH))).toBe(false);
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
      expect(fs.existsSync(path.join(repo.root, INDEX_WRITE_LOCK_PATH))).toBe(false);
    } finally { store.close(); registry.dispose(); }
  }, 120_000);
}
