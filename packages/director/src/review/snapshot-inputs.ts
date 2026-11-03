/**
 * #160 Stage 1 (H-103): the verdict inputs that the forbidden-import rule reads outside the reviewed diff.
 *
 * For --staged and --to <commit> the index describes the working tree. H-82 already refuses a verdict when a changed
 * path or Project Truth differs. A file outside the diff that differs is only a limitation, unless the rule used it to
 * decide. A rule uses such a file in four ways, collected here:
 *
 * - as the resolution of a changed import: whether a candidate of a relative TS/JS specifier (the path, its extension
 *   and index variants, a package.json in the directory) or the resolved target exists on each side;
 * - as resolver configuration of a non-relative TS/JS specifier (tsconfig*.json, jsconfig.json; package.json for a
 *   "#" subpath import);
 * - as a module whose re-exports the trace reads (it has export-from on either side), or as the target of such an
 *   export-from (its own exports decide which module provides a name);
 * - the same resolution checks for every export-from it follows.
 *
 * Content differences of a module that re-exports nothing on either side do not change the result, so they are not
 * inputs: an unrelated working-tree edit keeps today's verdict and limitation. Nothing is read from the reviewed side
 * except the text of a differing module (to see whether it re-exports); Stage 2 (reading inputs from the snapshot) is
 * separate.
 */
import path from "node:path";
import { compareUtf8, type RepoPath } from "@duo-director/core";
import type { IndexedModuleReference } from "@duo-director/graph";

/** How a path outside the diff differs: it exists on one side only, or exists on both with other content. */
export type Divergence = "existence" | "content";

const JS_IMPORTER = /\.[cm]?[jt]sx?$/u;
const SOURCE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const RESOLVER_CONFIG = /^(?:tsconfig(?:\..+)?\.json|jsconfig\.json)$/u;
/** An export-from statement anywhere in the text (over-approximates: only used to keep a differing module as an input). */
const EXPORT_FROM = /\bexport\b[^;]*?\bfrom\s*["']/u;

const stem = (p: string) => p.replace(SOURCE_EXTENSION, "");

export class VerdictInputs {
  private readonly found = new Set<string>();
  private readonly existence: readonly string[];
  private readonly resolverConfig: readonly string[];
  private readonly packageJson: readonly string[];

  /** reviewedText: a file's text on the reviewed side (undefined when absent there). */
  constructor(private readonly divergent: ReadonlyMap<string, Divergence>, private readonly reviewedText: (file: RepoPath) => Promise<string | undefined>) {
    const paths = [...divergent.keys()];
    this.existence = paths.filter((p) => divergent.get(p) === "existence");
    this.resolverConfig = paths.filter((p) => RESOLVER_CONFIG.test(path.posix.basename(p)));
    this.packageJson = paths.filter((p) => path.posix.basename(p) === "package.json");
  }

  /** A module reference of importer whose resolution decides the result (a changed import or a followed export-from). */
  reference(importer: RepoPath, ref: IndexedModuleReference): void {
    if (ref.target !== undefined && this.divergent.get(ref.target) === "existence") this.found.add(ref.target);
    if (!JS_IMPORTER.test(importer)) return;
    const specifier = ref.specifier;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = path.posix.normalize(specifier.startsWith("/") ? specifier.slice(1) : path.posix.join(path.posix.dirname(importer), specifier));
      if (base.startsWith("../")) return;
      const s = stem(base);
      for (const p of this.existence) {
        if (p === base || stem(p) === s || stem(p) === s + "/index" || p === s + "/package.json") this.found.add(p);
      }
      return;
    }
    for (const p of this.resolverConfig) this.found.add(p);
    if (specifier.startsWith("#")) for (const p of this.packageJson) this.found.add(p);
  }

  /**
   * A module the re-export trace read, with its indexed references. It is an input when it differs and re-exports on
   * either side, or when it is the target of a followed export-from (reached: its own exports decide the provider).
   */
  async module(file: RepoPath, references: readonly IndexedModuleReference[], reached: boolean): Promise<void> {
    const kind = this.divergent.get(file);
    if (kind === undefined) return;
    if (kind === "existence" || reached || references.some((r) => r.kind === "export-from")) { this.found.add(file); return; }
    if (EXPORT_FROM.test((await this.reviewedText(file)) ?? "")) this.found.add(file);
  }

  /** The differing verdict inputs, sorted. */
  paths(): string[] {
    return [...this.found].sort(compareUtf8);
  }
}

