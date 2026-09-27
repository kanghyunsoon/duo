import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fingerprintRepositoryFiles } from "../fingerprint/fingerprint.js";
import {
  canCreateSymlinks, createTempRepo, isCaseInsensitiveFileSystem, keepsDistinctUnicodeNames, makeTempDir, removeTempDirs, type TempRepo,
} from "../testing/git-repo.js";
import { scanRepository } from "./scanner.js";

afterAll(removeTempDirs);
// Each test spawns several git processes; process start-up is slow on Windows CI runners.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = new URL("../../../../fixtures/scan/basic/", import.meta.url);
interface ScenarioFile { readonly path: string; readonly tracked: boolean; readonly text?: string; readonly base64?: string }
const scenario = JSON.parse(fs.readFileSync(new URL("scenario.json", FIXTURE), "utf8")) as {
  readonly options: { readonly include?: string[]; readonly exclude?: string[] };
  readonly files: readonly ScenarioFile[];
};

function buildScenario(): TempRepo {
  const repo = createTempRepo();
  for (const f of scenario.files) repo.write(f.path, f.base64 !== undefined ? Buffer.from(f.base64, "base64") : (f.text ?? ""));
  // -f: tracked files may match .gitignore (tracked.log); they stay tracked.
  repo.git("add", "-f", "--", ...scenario.files.filter((f) => f.tracked).map((f) => f.path));
  return repo;
}

const codes = (scan: { diagnostics: readonly { code: string; source?: { path: string } }[] }) =>
  scan.diagnostics.map((d) => [d.code, d.source?.path]);

describe("scanRepository golden (AC-004-01, AC-004-02)", () => {
  it("matches the included/excluded golden and the fingerprints on every OS", async () => {
    const repo = buildScenario();
    const scan = await scanRepository(repo.root, scenario.options);
    const { fingerprints, diagnostics } = await fingerprintRepositoryFiles(repo.root, scan.files);
    const actual = { files: fingerprints, excluded: scan.excluded, typeChanges: scan.typeChanges, diagnostics: [...codes(scan), ...codes({ diagnostics })] };
    const golden = new URL("expected.json", FIXTURE);
    if (process.env.DUO_UPDATE_GOLDEN === "1") fs.writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(fs.readFileSync(golden, "utf8")));
  });

  it("never lists ignored files, secrets or DUO's regenerable data as indexable", async () => {
    const repo = buildScenario();
    const scan = await scanRepository(repo.root, scenario.options);
    const listed = scan.files.map((f) => f.path);
    for (const p of ["debug.log", "node_modules/pkg/index.js", ".env", ".env.example", "config/credentials.json", "keys/server.PEM", "deploy/id_rsa", ".duo-project/generated/graph.db"]) {
      expect(listed).not.toContain(p);
    }
    expect(scan.excluded.map((e) => e.path)).not.toContain("debug.log");
    expect(listed).toContain("tracked.log");
    expect(scan.files.every((f) => (f.state === "tracked") === (f.gitBlobOid !== undefined))).toBe(true);
  });

  it("applies index.include", async () => {
    const repo = buildScenario();
    const scan = await scanRepository(repo.root, { include: ["src/**"] });
    expect(scan.files.map((f) => f.path)).toEqual(["src/index.ts", "src/new-feature.ts", "src/util/str.ts", "src/\uD55C\uAE00.ts"]);
    expect(scan.excluded.find((e) => e.path === "README.md")?.reason).toBe("not-included");
    // Secrets stay excluded even when include would match them.
    const secrets = await scanRepository(repo.root, { include: ["**"] });
    expect(secrets.excluded.find((e) => e.path === ".env")?.reason).toBe("secret");
  });
});

describe("scan root", () => {
  it("requires a Git repository (C36)", async () => {
    const scan = await scanRepository(makeTempDir("duo-nogit-"));
    expect(scan.files).toEqual([]);
    expect(codes(scan)).toEqual([["GIT_REPOSITORY_REQUIRED", undefined]]);
  });

  it("rejects a subdirectory of a work tree", async () => {
    const repo = createTempRepo();
    repo.write("sub/a.ts", "x\n");
    const scan = await scanRepository(path.join(repo.root, "sub"));
    expect(codes(scan)).toEqual([["SCAN_ROOT_INVALID", undefined]]);
  });

  it("reports a pattern that is not a repository glob", async () => {
    const repo = createTempRepo();
    repo.write("a.ts", "x\n");
    const scan = await scanRepository(repo.root, { exclude: ["../outside/**"] });
    expect(codes(scan)).toEqual([["INVALID_PATH", undefined]]);
    expect(scan.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("Git is the path source", () => {
  it("uses the index spelling for tracked files", async () => {
    const repo = createTempRepo();
    repo.write("Readme.md", "hello\n");
    repo.add("Readme.md");
    fs.renameSync(path.join(repo.root, "Readme.md"), path.join(repo.root, "README.md"));
    const scan = await scanRepository(repo.root);
    if (isCaseInsensitiveFileSystem()) {
      // Windows/macOS: the same file, still identified by the index spelling.
      expect(scan.files).toMatchObject([{ path: "Readme.md", state: "tracked" }]);
    } else {
      // Case-sensitive: the tracked file is gone and a new untracked file exists.
      expect(scan.files).toMatchObject([{ path: "README.md", state: "untracked" }]);
      expect(scan.excluded).toEqual([{ path: "Readme.md", state: "tracked", reason: "missing" }]);
    }
  });

  it("excludes tracked files deleted from the working tree", async () => {
    const repo = createTempRepo();
    repo.write("gone.ts", "x\n");
    repo.add("gone.ts");
    fs.rmSync(path.join(repo.root, "gone.ts"));
    const scan = await scanRepository(repo.root);
    expect(scan.files).toEqual([]);
    expect(scan.excluded).toEqual([{ path: "gone.ts", state: "tracked", reason: "missing" }]);
  });

  it("skips nested repositories", async () => {
    const repo = createTempRepo();
    repo.write("a.ts", "x\n");
    const nested = createTempRepo();
    fs.renameSync(nested.root, path.join(repo.root, "vendor"));
    fs.writeFileSync(path.join(repo.root, "vendor", "b.ts"), "y\n");
    const scan = await scanRepository(repo.root);
    expect(scan.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(scan.excluded).toEqual([{ path: "vendor", state: "untracked", reason: "nested-repository" }]);
    expect(codes(scan)).toEqual([["SCAN_ENTRY_SKIPPED", "vendor"]]);
  });

  it.runIf(process.platform !== "win32")("skips names that are not portable RepoPaths", async () => {
    const repo = createTempRepo();
    repo.write("a\\b.ts", "x\n");
    const scan = await scanRepository(repo.root);
    expect(scan.files).toEqual([]);
    expect(scan.diagnostics.map((d) => d.code)).toEqual(["SCAN_ENTRY_SKIPPED"]);
  });
});

describe("PATH_PORTABILITY_COLLISION", () => {
  it.runIf(!isCaseInsensitiveFileSystem())("reports untracked paths that differ only by case", async () => {
    const repo = createTempRepo();
    repo.write("src/Auth.ts", "a\n");
    repo.write("src/auth.ts", "b\n");
    const scan = await scanRepository(repo.root);
    expect(codes(scan)).toEqual([["PATH_PORTABILITY_COLLISION", "src/Auth.ts"]]);
  });

  it.runIf(keepsDistinctUnicodeNames())("reports untracked paths that differ only by Unicode normalization", async () => {
    const repo = createTempRepo();
    repo.write("caf\u00E9.ts", "a\n");
    repo.write("cafe\u0301.ts", "b\n");
    const scan = await scanRepository(repo.root);
    expect(scan.diagnostics.map((d) => d.code)).toEqual(["PATH_PORTABILITY_COLLISION"]);
  });

  it("reports tracked index entries that collide (every OS)", async () => {
    const repo = createTempRepo();
    repo.write("Guide.md", "a\n");
    repo.add("Guide.md");
    // A second index entry that differs only by case, as a commit from a case-sensitive OS would create.
    const oid = repo.git("hash-object", "-w", "Guide.md").trim();
    repo.git("update-index", "--add", "--cacheinfo", `100644,${oid},guide.md`);
    if (!isCaseInsensitiveFileSystem()) repo.write("guide.md", "a\n");
    const scan = await scanRepository(repo.root);
    expect(scan.files.map((f) => f.path)).toEqual(["Guide.md", "guide.md"]);
    expect(codes(scan)).toEqual([["PATH_PORTABILITY_COLLISION", "Guide.md"]]);
  });
});

describe("symlinks are never followed", () => {
  it("skips symlinks recorded in the index even when checked out as plain files (every OS)", async () => {
    const repo = createTempRepo();
    repo.addSymlinkEntry("inside-link", "src/a.ts");
    repo.addSymlinkEntry("outside-link", "../../etc/passwd");
    repo.write("inside-link", "src/a.ts");
    repo.write("outside-link", "../../etc/passwd");
    const scan = await scanRepository(repo.root);
    expect(scan.files).toEqual([]);
    expect(scan.excluded.map((e) => [e.path, e.reason])).toEqual([["inside-link", "symlink"], ["outside-link", "symlink"]]);
    expect(codes(scan)).toEqual([["SYMLINK_SKIPPED", "inside-link"], ["SYMLINK_OUTSIDE_REPOSITORY", "outside-link"]]);
  });

  const symlinks = canCreateSymlinks();

  it("treats a symlink checked out as a plain file (core.symlinks=false) as the expected checkout, not a type change", async () => {
    const repo = createTempRepo();
    repo.git("config", "core.symlinks", "false");
    repo.addSymlinkEntry("link", "src/a.ts");
    repo.write("link", "src/a.ts");
    const scan = await scanRepository(repo.root);
    expect(scan.typeChanges).toEqual([]);
    expect(scan.excluded).toEqual([{ path: "link", state: "tracked", reason: "symlink" }]);
  });

  it("reports an index symlink replaced by a regular file (FILE_TYPE_CHANGED) and indexes the file without gitBlobOid", async () => {
    const repo = createTempRepo();
    repo.git("config", "core.symlinks", "true");
    repo.addSymlinkEntry("link", "src/a.ts");
    repo.write("link", "now a real file\n");
    const scan = await scanRepository(repo.root);
    expect(scan.typeChanges).toEqual([{ path: "link", index: "symlink", workingTree: "regular-file" }]);
    expect(scan.files).toEqual([{ path: "link", state: "tracked" }]);
    expect(codes(scan)).toEqual([["FILE_TYPE_CHANGED", "link"]]);
  });

  it.runIf(symlinks)("reports a tracked file replaced by a symlink and still does not read the target", async () => {
    const repo = createTempRepo();
    repo.write("a.ts", "x\n");
    repo.add("a.ts");
    const outside = makeTempDir("duo-outside-");
    fs.writeFileSync(path.join(outside, "secret.ts"), "outside\n");
    fs.rmSync(path.join(repo.root, "a.ts"));
    fs.symlinkSync(path.join(outside, "secret.ts"), path.join(repo.root, "a.ts"), "file");
    const scan = await scanRepository(repo.root);
    const { fingerprints } = await fingerprintRepositoryFiles(repo.root, scan.files);
    expect(fingerprints).toEqual([]);
    expect(scan.typeChanges).toEqual([{ path: "a.ts", index: "regular-file", workingTree: "symlink" }]);
    expect(scan.excluded).toEqual([{ path: "a.ts", state: "tracked", reason: "symlink" }]);
    expect(codes(scan)).toEqual([["FILE_TYPE_CHANGED", "a.ts"], ["SYMLINK_OUTSIDE_REPOSITORY", "a.ts"]]);
  });

  it.runIf(symlinks)("does not read the target of an untracked symlink to a file outside the repository", async () => {
    const repo = createTempRepo();
    const outside = makeTempDir("duo-outside-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo.root, "link.txt"), "file");
    repo.write("a.ts", "x\n");
    const scan = await scanRepository(repo.root);
    expect(scan.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(codes(scan)).toEqual([["SYMLINK_OUTSIDE_REPOSITORY", "link.txt"]]);
  });

  it.runIf(symlinks)("skips tracked files below a directory that became a symlink", async () => {
    const repo = createTempRepo();
    repo.write("lib/a.ts", "x\n");
    repo.add("lib/a.ts");
    const outside = makeTempDir("duo-outside-");
    fs.writeFileSync(path.join(outside, "a.ts"), "outside\n");
    fs.rmSync(path.join(repo.root, "lib"), { recursive: true });
    fs.symlinkSync(outside, path.join(repo.root, "lib"), "dir");
    const scan = await scanRepository(repo.root);
    const { fingerprints } = await fingerprintRepositoryFiles(repo.root, scan.files);
    expect(fingerprints).toEqual([]);
    expect(scan.files).toEqual([]);
    // Git may also report the link itself ("lib") as untracked; either way it is a symlink exclusion.
    expect(scan.excluded).toContainEqual({ path: "lib/a.ts", state: "tracked", reason: "symlink" });
    expect(scan.excluded.every((e) => e.reason === "symlink" && (e.path === "lib" || e.path === "lib/a.ts"))).toBe(true);
    expect(codes(scan)).toEqual([["SYMLINK_OUTSIDE_REPOSITORY", "lib"]]);
  });
});
