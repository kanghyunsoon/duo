/**
 * The lock path checks of tryAcquireFileLock (#148 review): the check before the open and the check
 * after it, through the open connection, for a path swapped between the two; and the same refusals
 * through the public withIndexWriteLock. Here because only this directory may import node:sqlite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { FileLockRefusedError, tryAcquireFileLock } from "./file-lock.js";
import { INDEX_WRITE_LOCK_PATH, withIndexWriteLock } from "../../incremental/write-lock.js";
import { makeRepo } from "../../incremental/testing.js";

const temps: string[] = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
afterEach(() => { vi.restoreAllMocks(); });
const tempDir = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duo-file-lock-"))); temps.push(dir); return dir; };

function walDatabase(file: string): Buffer {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1)");
  db.close();
  return fs.readFileSync(file);
}
const absent = (): never => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const emptyFile = { isSymbolicLink: () => false, isFile: () => true, nlink: 1, size: 0, dev: 1, ino: 1 } as unknown as fs.Stats;

describe("tryAcquireFileLock", () => {
  it("takes, reports held and releases a lock on a fresh path", () => {
    const file = path.join(tempDir(), "index-writer.lock");
    const held = tryAcquireFileLock(file);
    expect(held).toBeDefined();
    expect(tryAcquireFileLock(file)).toBeUndefined();
    held?.release();
    const again = tryAcquireFileLock(file);
    expect(again).toBeDefined();
    again?.release();
    expect(fs.statSync(file).size).toBe(0);
  });

  it("refuses a path that became a hard link between the check and the open", () => {
    const dir = tempDir();
    const external = path.join(tempDir(), "external.db");
    const bytes = walDatabase(external);
    const file = path.join(dir, "index-writer.lock");
    fs.linkSync(external, file);
    // The check before the open saw no file; the check after it sees the hard link.
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementationOnce(absent);
    expect(() => tryAcquireFileLock(file)).toThrow(FileLockRefusedError);
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(external).equals(bytes)).toBe(true);
  });

  it("refuses through the open connection when the path checks were both passed but the opened file is a database", () => {
    const external = path.join(tempDir(), "external.db");
    const bytes = walDatabase(external);
    const file = path.join(tempDir(), "index-writer.lock");
    fs.linkSync(external, file);
    // Both path checks are deceived (a swap back and forth); only the connection sees the real file.
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementationOnce(absent).mockImplementationOnce(() => emptyFile);
    expect(() => tryAcquireFileLock(file)).toThrow(/opened file is not empty/u);
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(external).equals(bytes)).toBe(true);
  });
});

describe("withIndexWriteLock with an alias at the lock path (#148 review)", () => {
  for (const kind of ["hard link", "non-empty file"] as const) {
    it(`refuses a ${kind} before SQLite opens it and leaves the external WAL database unchanged`, async () => {
      const repo = makeRepo(temps, { ".duo-project/project.yaml": "schema_version: 1\nname: hardlink\n", "src/a.ts": "export const a = 1;\n" });
      const outside = tempDir();
      const external = path.join(outside, "external.db");
      const bytes = walDatabase(external);
      const lock = path.join(repo.root, INDEX_WRITE_LOCK_PATH);
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      if (kind === "hard link") fs.linkSync(external, lock);
      else fs.copyFileSync(external, lock);
      let ran = false;
      const result = await withIndexWriteLock(repo.root, async () => { ran = true; }, { lockTimeoutMs: 0 });
      expect(ran).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.diagnostics[0]).toMatchObject({
        code: "GRAPH_WRITE_REFUSED",
        message: expect.stringContaining(kind === "hard link" ? "it is a hard link (2 links)" : "it is not empty"),
      });
      expect(fs.readFileSync(external).equals(bytes)).toBe(true);
      expect(fs.readdirSync(outside)).toEqual(["external.db"]);
      expect(fs.readdirSync(path.dirname(lock))).toEqual(["index-writer.lock"]);
      if (kind === "hard link") expect(fs.lstatSync(lock).nlink).toBe(2);
    });
  }
});
