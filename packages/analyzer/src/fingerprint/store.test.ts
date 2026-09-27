import fs from "node:fs";
import path from "node:path";
import type { RepoPath } from "@duo-director/core";
import { afterAll, describe, expect, it } from "vitest";
import { canCreateSymlinks, makeTempDir, removeTempDirs } from "../testing/git-repo.js";
import type { FileFingerprint } from "./fingerprint.js";
import { FINGERPRINT_FILE_PATH, parseFingerprints, readFingerprintFile, serializeFingerprints, writeFingerprintFile } from "./store.js";

afterAll(removeTempDirs);

const h = (c: string) => `sha256:${c.repeat(64)}`;
const FPS: FileFingerprint[] = [
  { path: "src/\u{1F600}.ts" as RepoPath, state: "untracked", fingerprintMode: "normalized-text", contentHash: h("b"), size: 3 },
  { path: "src/\uFF5E.ts" as RepoPath, state: "tracked", fingerprintMode: "normalized-text", contentHash: h("a"), size: 2, gitBlobOid: "1".repeat(40) },
  { path: "README.md" as RepoPath, state: "tracked", fingerprintMode: "raw", contentHash: h("c"), size: 0 },
];
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe("fingerprints.json", () => {
  it("serializes deterministically in UTF-8 path order without timestamps", () => {
    const text = serializeFingerprints(FPS);
    expect(serializeFingerprints([...FPS].reverse())).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    const doc = JSON.parse(text) as { format: string; version: number; files: { path: string }[] };
    expect(Object.keys(doc)).toEqual(["format", "version", "files"]);
    expect(doc.files.map((f) => f.path)).toEqual(["README.md", "src/\uFF5E.ts", "src/\u{1F600}.ts"]);
    expect(Object.keys(doc.files[1] ?? {})).toEqual(["path", "state", "fingerprintMode", "contentHash", "size", "gitBlobOid"]);
  });

  it("round-trips", () => {
    expect(parseFingerprints(serializeFingerprints(FPS)).value).toEqual([FPS[2], FPS[1], FPS[0]]);
  });

  it.each([
    ["not JSON", "{"],
    ["another format", JSON.stringify({ format: "x", version: 1, files: [] })],
    ["the previous version", JSON.stringify({ format: "duo-fingerprints", version: 1, files: [] })],
    ["unknown key", JSON.stringify({ format: "duo-fingerprints", version: 2, files: [{ path: "a", state: "tracked", fingerprintMode: "normalized-text", contentHash: h("a"), size: 1, mtime: 5 }] })],
    ["bad path", JSON.stringify({ format: "duo-fingerprints", version: 2, files: [{ path: "../a", state: "tracked", fingerprintMode: "normalized-text", contentHash: h("a"), size: 1 }] })],
    ["bad hash", JSON.stringify({ format: "duo-fingerprints", version: 2, files: [{ path: "a", state: "tracked", fingerprintMode: "normalized-text", contentHash: "md5:x", size: 1 }] })],
    ["duplicate", JSON.stringify({ format: "duo-fingerprints", version: 2, files: [{ path: "a", state: "tracked", fingerprintMode: "normalized-text", contentHash: h("a"), size: 1 }, { path: "a", state: "tracked", fingerprintMode: "normalized-text", contentHash: h("a"), size: 1 }] })],
  ])("rejects %s as FINGERPRINT_CACHE_INVALID", (_name, text) => {
    const r = parseFingerprints(text);
    expect(r.value).toBeUndefined();
    expect(codes(r)).toEqual(["FINGERPRINT_CACHE_INVALID"]);
  });

  it("writes under generated/ and reads it back; a missing file is an empty cache", () => {
    const root = makeTempDir("duo-fp-");
    expect(readFingerprintFile(root)).toEqual({ value: [], diagnostics: [] });
    expect(writeFingerprintFile(root, FPS)).toEqual({ value: FINGERPRINT_FILE_PATH, diagnostics: [] });
    const written = fs.readFileSync(path.join(root, ".duo-project", "generated", "fingerprints.json"), "utf8");
    expect(written).toBe(serializeFingerprints(FPS));
    expect(readFingerprintFile(root).value).toEqual([FPS[2], FPS[1], FPS[0]]);
    expect(fs.readdirSync(path.join(root, ".duo-project", "generated"))).toEqual(["fingerprints.json"]);
  });

  it("treats an invalid cache as empty with a warning", () => {
    const root = makeTempDir("duo-fp-");
    fs.mkdirSync(path.join(root, ".duo-project", "generated"), { recursive: true });
    fs.writeFileSync(path.join(root, FINGERPRINT_FILE_PATH), JSON.stringify({ format: "duo-fingerprints", version: 0, files: [] }));
    const r = readFingerprintFile(root);
    expect(r.value).toEqual([]);
    expect(codes(r)).toEqual(["FINGERPRINT_CACHE_INVALID"]);
    expect(r.diagnostics[0]?.severity).toBe("warning");
  });

  it.runIf(canCreateSymlinks())("refuses to write through a symlinked generated/ directory", () => {
    const root = makeTempDir("duo-fp-");
    const outside = makeTempDir("duo-outside-");
    fs.mkdirSync(path.join(root, ".duo-project"));
    fs.symlinkSync(outside, path.join(root, ".duo-project", "generated"), "dir");
    expect(codes(writeFingerprintFile(root, FPS))).toEqual(["WRITE_NOT_ALLOWED"]);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(codes(readFingerprintFile(root))).toEqual(["FINGERPRINT_CACHE_INVALID"]);
  });
});
