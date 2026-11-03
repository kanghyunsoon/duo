import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { computeContentHash, fingerprintModeOf, openGitProvider, scanRepository, type GitRepositoryState } from "@duo-director/analyzer";
import { compareUtf8, createDiagnostic, failure, normalizeRepoPath, STATE_DIR_NAME, success, type ParseResult } from "@duo-director/core";

/** Content-based stability guard; deliberately independent of mtime and index freshness caches.
 * Scan without user include/exclude so Truth and resolution configs are also observed.
 */
export async function captureIndexInputs(root: string, extra: readonly string[] = []): Promise<ParseResult<{ signature: string; git: GitRepositoryState; hashes: ReadonlyMap<string, string>; rawHashes: ReadonlyMap<string, string> }>> {
  const scan = await scanRepository(root);
  const git = await openGitProvider(root);
  const state = await git.value?.repositoryState();
  const diagnostics = [...scan.diagnostics, ...git.diagnostics, ...(state?.diagnostics ?? [])];
  if (diagnostics.some((d) => d.severity === "error") || state?.value === undefined) return failure(diagnostics);
  const files = new Map(scan.files.map((f) => [f.path as string, f]));
  try {
    // Truth is loaded directly from disk even when Git ignores it. Observe directory membership too.
    const truthPaths = [`${STATE_DIR_NAME}/project.yaml`];
    const walk = (relative: string): void => {
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) return;
      if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`Symlink Truth input: ${relative}`);
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Symlink Truth input: ${child}`);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) truthPaths.push(child);
      }
    };
    for (const dir of ["intent", "specs", "decisions", "milestones", "integrations"]) walk(`${STATE_DIR_NAME}/${dir}`);
    const paths = [...new Set([...files.keys(), ...truthPaths, ...extra])].sort(compareUtf8);
    const hashes = new Map<string, string>();
    const rawHashes = new Map<string, string>();
    const contents = paths.map((p) => {
      const normalized = normalizeRepoPath(p).value;
      if (normalized === undefined || normalized !== p) throw new Error(`Invalid input path: ${p}`);
      const absolute = path.resolve(root, p);
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const entry = path.join(root, ...parts.slice(0, i));
        if (fs.existsSync(entry) && fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Symlink input: ${p}`);
      }
      if (!fs.existsSync(absolute)) return [p, files.get(p), null];
      const bytes = fs.readFileSync(absolute);
      const rawHash = createHash("sha256").update(bytes).digest("hex");
      hashes.set(p, computeContentHash(bytes, fingerprintModeOf(normalized)).contentHash);
      rawHashes.set(p, rawHash);
      return [p, files.get(p), rawHash];
    });
    return success({ signature: JSON.stringify([state.value, contents, scan.typeChanges]), git: state.value, hashes, rawHashes });
  } catch (error) {
    return failure([createDiagnostic("GRAPH_WRITE_REFUSED", `Cannot verify index inputs: ${(error as Error).message}`)]);
  }
}
