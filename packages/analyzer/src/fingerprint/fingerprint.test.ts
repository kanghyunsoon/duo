import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scanRepository } from "../scan/scanner.js";
import { createTempRepo, removeTempDirs, type TempRepo } from "../testing/git-repo.js";
import { compareFingerprints } from "./compare.js";
import { fingerprintRepositoryFiles, type FileFingerprint } from "./fingerprint.js";
import { readFingerprintFile, writeFingerprintFile } from "./store.js";

afterAll(removeTempDirs);
vi.setConfig({ testTimeout: 30_000 });

async function snapshot(repo: TempRepo): Promise<FileFingerprint[]> {
  const scan = await scanRepository(repo.root);
  const result = await fingerprintRepositoryFiles(repo.root, scan.files);
  expect(result.diagnostics).toEqual([]);
  return [...result.fingerprints];
}

describe("freshness by content (AC-004-03)", () => {
  it("detects changes from contentHash, not from mtime", async () => {
    const repo = createTempRepo();
    repo.write("touched.ts", "export const a = 1;\n");
    repo.write("edited.ts", "export const b = 1;\n");
    repo.write("eol.md", "line\r\n");
    repo.write("gone.ts", "x\n");
    repo.add("touched.ts", "edited.ts", "eol.md", "gone.ts");
    expect(writeFingerprintFile(repo.root, await snapshot(repo)).diagnostics).toEqual([]);

    // mtime only; same-size edit; EOL-only checkout change; delete; add.
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(path.join(repo.root, "touched.ts"), future, future);
    repo.write("edited.ts", "export const b = 2;\n");
    repo.write("eol.md", "line\n");
    fs.rmSync(path.join(repo.root, "gone.ts"));
    repo.write("added.ts", "y\n");

    const previous = readFingerprintFile(repo.root);
    expect(previous.diagnostics).toEqual([]);
    const changes = compareFingerprints(previous.value ?? [], await snapshot(repo));
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ["added.ts", "ADDED"],
      ["edited.ts", "CHANGED"],
      ["eol.md", "UNCHANGED"],
      ["gone.ts", "DELETED"],
      ["touched.ts", "UNCHANGED"],
    ]);
  });

  it("produces the same fingerprints file twice in a row", async () => {
    const repo = createTempRepo();
    repo.write("a.ts", "a\n");
    repo.write("b/c.md", "c\n");
    repo.add("a.ts");
    writeFingerprintFile(repo.root, await snapshot(repo));
    const first = fs.readFileSync(path.join(repo.root, ".duo-project/generated/fingerprints.json"), "utf8");
    // The fingerprint file itself is regenerable DUO data and is not scanned.
    writeFingerprintFile(repo.root, await snapshot(repo));
    expect(fs.readFileSync(path.join(repo.root, ".duo-project/generated/fingerprints.json"), "utf8")).toBe(first);
  });
});
