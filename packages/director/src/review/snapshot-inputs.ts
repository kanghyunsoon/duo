/**
 * #160 Stage 1 (H-103): the verdict inputs that the forbidden-import rule reads outside the reviewed diff.
 *
 * For --staged and --to <commit> the index describes the working tree. H-82 already refuses a verdict when a changed
 * path or Project Truth differs. A file outside the diff that differs is only a limitation, unless the rule used it to
 * decide. A rule uses such a file in these ways, collected here:
 *
 * - as the resolution of a changed import: whether a candidate of a relative TS/JS specifier (the path, its extension
 *   and index variants, a package.json in the directory) or the resolved target exists on each side. A non-relative
 *   specifier (tsconfig paths/baseUrl/rootDirs, package imports, a package) is resolved once more with the indexer's
 *   TypeScript resolver on the working tree, recording every file it looks up; a looked-up file whose existence
 *   differs counts. With the same configuration on both sides (otherwise the config itself counts), those lookups
 *   include every candidate the reviewed side's resolution would try before it stops;
 * - as the resolver configuration of a TS/JS importer, as the TypeScript resolver reads it (graph
 *   typescript-module-resolver.ts): the nearest tsconfig.json or jsconfig.json up to the repository root with its
 *   extends chain, and the nearest package.json. A config whose existence differs on the way up changes which one
 *   applies. A config that exists on both sides counts only when a field that decides resolution differs;
 * - as a module whose re-exports the trace reads (it has export-from on either side), or as the target of such an
 *   export-from (its own exports decide which module provides a name);
 * - the same resolution checks for every export-from it follows.
 * - for a Python importer (#160 Stage 2, non-TS/JS imports): the indexer's Python resolution (relative imports and the
 *   discovered source roots) run on both sides' file sets. When the result differs, the paths that decide it (the
 *   resolved or candidate modules, otherwise an __init__.py or project metadata file whose existence or text differs)
 *   are inputs. Only files whose existence or text can change a Python resolution are compared.
 *
 * Content differences that cannot change the result are not inputs: a module that re-exports nothing on either side
 * (an export-from in a comment or a string does not count), a config of another directory, or a config option that
 * resolution does not read. Such working-tree edits keep today's verdict and limitation. Stage 2 (reading the inputs
 * from the snapshot) is separate.
 */
import { builtinModules } from "node:module";
import path from "node:path";
import { compareUtf8, type RepoPath } from "@duo-director/core";
import {
  createTypeScriptModuleResolver, discoverPythonRoots, resolvePython, type IndexedModuleReference, type ModuleResolution, type ModuleResolver, type PythonRoots,
} from "@duo-director/graph";

/** How a path outside the diff differs: it exists on one side only, or exists on both with other content. */
export type Divergence = "existence" | "content";

type Text = (file: string) => string | undefined | Promise<string | undefined>;
type PythonSide = { readonly files: ReadonlySet<string>; readonly roots: PythonRoots };
/** The indexed repository files (the working tree side of the index), read once and only when a Python import needs it. */
type IndexedFiles = () => ReadonlySet<string> | Promise<ReadonlySet<string>>;

const JS_IMPORTER = /\.[cm]?[jt]sx?$/u;
const PY_IMPORTER = /\.py$/u;
/** Python project metadata whose text decides source roots (graph python.ts METADATA_FILE). */
const PY_METADATA = /(?:^|\/)(?:pyproject\.toml|setup\.cfg)$/u;
/** A file whose existence or text can change a Python resolution: a module, a package marker, metadata, setup.py. */
const PY_RESOLUTION_FILE = /(?:\.py|(?:^|\/)(?:pyproject\.toml|setup\.cfg))$/u;
const SOURCE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/u;
const BUILTINS = new Set(builtinModules);
const URL_SPECIFIER = /^[a-z][a-z0-9+.-]*:/iu;
const MAX_EXTENDS = 8;
/** compilerOptions the TypeScript resolver reads (lower case: tsconfig option names are case-insensitive). */
const RESOLUTION_OPTIONS = new Set([
  "allowarbitraryextensions", "allowimportingtsextensions", "allowjs", "baseurl", "customconditions", "module", "moduleresolution",
  "modulesuffixes", "paths", "preservesymlinks", "resolvejsonmodule", "resolvepackagejsonexports", "resolvepackagejsonimports", "rootdirs",
  "typeroots", "types",
]);
/** package.json fields that decide module format or resolution. */
const PACKAGE_FIELDS = ["browser", "exports", "imports", "main", "module", "name", "type", "types", "typesVersions", "typings"];
const QUOTES = new Set(['"', "'", "`"]);

const stem = (p: string) => p.replace(SOURCE_EXTENSION, "");
const resolutionPaths = (r: ModuleResolution): readonly string[] => (r.status === "resolved" ? [r.path] : r.status === "ambiguous" ? r.candidates : []);
const resolutionKey = (r: ModuleResolution) => JSON.stringify([r.status, ...resolutionPaths(r)]);

/**
 * The text with comments removed and string and template contents blanked (quotes kept), so that only real
 * statements remain. Single- and double-quoted strings end at a line break, which bounds a misread regex literal.
 */
export function codeOnly(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i++; }
      i++;
      out += " ";
    } else if (QUOTES.has(c)) {
      out += c;
      i++;
      while (i < text.length && text[i] !== c && !(c !== "`" && text[i] === "\n")) {
        if (text[i] === "\\") i++;
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) out += text[i];
    } else {
      out += c;
    }
  }
  return out;
}

const EXPORT_FROM = /(?:^|[;{}])\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'`]/mu;
/** Whether the source re-exports from another module (an export-from statement outside comments and strings). */
export function reexports(text: string): boolean {
  return EXPORT_FROM.test(codeOnly(text));
}

/** Comments removed, strings kept (JSON with comments). */
function withoutComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; out += " "; continue; }
    out += c;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") { out += text[i]; i++; } out += text[i] ?? ""; i++; }
      if (i < text.length) out += '"';
    }
  }
  return out;
}

/** tsconfig/jsconfig/package.json text as JSON (comments and trailing commas allowed); undefined when unreadable. */
function json(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(withoutComments(text).replace(/,(\s*[}\]])/gu, "$1"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).sort(compareUtf8).map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;

/** What the TypeScript resolver reads from a tsconfig/jsconfig; undefined when it cannot be read. */
function configResolution(text: string | undefined): string | undefined {
  const config = json(text);
  if (config === undefined) return undefined;
  const options = typeof config.compilerOptions === "object" && config.compilerOptions !== null ? (config.compilerOptions as Record<string, unknown>) : {};
  const relevant = Object.fromEntries(Object.entries(options).map(([k, v]) => [k.toLowerCase(), v] as const).filter(([k]) => RESOLUTION_OPTIONS.has(k)));
  return JSON.stringify(sorted({ extends: config.extends ?? null, compilerOptions: relevant }));
}

function packageResolution(text: string | undefined): string | undefined {
  const pkg = json(text);
  return pkg === undefined ? undefined : JSON.stringify(sorted(Object.fromEntries(PACKAGE_FIELDS.map((f) => [f, pkg[f] ?? null]))));
}

export class VerdictInputs {
  private readonly found = new Set<string>();
  private readonly existence: readonly string[];
  private readonly configMemo = new Map<string, Promise<readonly string[]>>();
  /** Every repository file the TypeScript resolver looked up for a non-relative specifier (#163 review). */
  private readonly lookedUp = new Set<string>();
  /**
   * Every repository directory the TypeScript resolver found missing in the working tree (#163 review). The resolver
   * does not look up candidates inside it, so an existence difference under it counts as looked up.
   */
  private readonly missingDirectories = new Set<string>();
  private resolver: ModuleResolver | undefined;
  /** The Python file sets and source roots of both sides, built once per review (#160 Stage 2). */
  private python: Promise<{ readonly worktree: PythonSide; readonly reviewed: PythonSide } | undefined> | undefined;

  /**
   * reviewedText / worktreeText: a file's text on the reviewed side and in the working tree (undefined when absent).
   * indexedFiles: the indexed file set; without it Python imports are checked only by their indexed target (Stage 1).
   */
  constructor(
    private readonly root: string, private readonly divergent: ReadonlyMap<string, Divergence>, private readonly reviewedText: Text, private readonly worktreeText: Text,
    private readonly indexedFiles?: IndexedFiles,
  ) {
    this.existence = [...divergent.keys()].filter((p) => divergent.get(p) === "existence");
  }

  /** A module reference of importer whose resolution decides the result (a changed import or a followed export-from). */
  async reference(importer: RepoPath, ref: IndexedModuleReference): Promise<void> {
    if (ref.target !== undefined && this.divergent.get(ref.target) === "existence") this.found.add(ref.target);
    if (PY_IMPORTER.test(importer)) { await this.pythonReference(importer, ref); return; }
    if (!JS_IMPORTER.test(importer)) return;
    const specifier = ref.specifier;
    if (specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0] ?? "") || URL_SPECIFIER.test(specifier)) return;
    for (const p of await this.configsOf(path.posix.dirname(importer))) this.found.add(p);
    if (!(specifier.startsWith(".") || specifier.startsWith("/"))) {
      // Only the resolver knows which files paths, baseUrl, rootDirs or package imports map it to (#163 review).
      if (this.existence.length === 0) return;
      const inside = (absolute: string): string | undefined => {
        const relative = path.relative(this.root, absolute).split(path.sep).join("/");
        return relative !== "" && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : undefined;
      };
      this.resolver ??= createTypeScriptModuleResolver({
        root: this.root,
        indexedFiles: new Set(),
        readInput: (file, read) => {
          const relative = inside(file);
          if (relative !== undefined) this.lookedUp.add(relative);
          return read();
        },
        observeDirectory: (directory, exists) => {
          const relative = exists ? undefined : inside(directory);
          if (relative !== undefined) this.missingDirectories.add(relative);
        },
      });
      this.resolver.resolve({ fromPath: importer, specifier, kind: ref.kind });
      const missing = [...this.missingDirectories];
      for (const p of this.existence) if (this.lookedUp.has(p) || missing.some((d) => p.startsWith(d + "/"))) this.found.add(p);
      return;
    }
    const base = path.posix.normalize(specifier.startsWith("/") ? specifier.slice(1) : path.posix.join(path.posix.dirname(importer), specifier));
    if (base.startsWith("../")) return;
    const s = stem(base);
    for (const p of this.existence) {
      if (p === base || stem(p) === s || stem(p) === s + "/index" || p === s + "/package.json") this.found.add(p);
    }
  }

  /**
   * A module the re-export trace read, with its indexed references. It is an input when it differs and re-exports on
   * either side, or when it is the target of a followed export-from (reached: its own exports decide the provider).
   */
  async module(file: RepoPath, references: readonly IndexedModuleReference[], reached: boolean): Promise<void> {
    const kind = this.divergent.get(file);
    if (kind === undefined) return;
    if (kind === "existence" || reached || references.some((r) => r.kind === "export-from")) { this.found.add(file); return; }
    if (reexports((await this.reviewedText(file)) ?? "")) this.found.add(file);
  }

  /** The differing verdict inputs, sorted. */
  paths(): string[] {
    return [...this.found].sort(compareUtf8);
  }

  /**
   * #160 Stage 2: a Python import resolved on both sides. The index resolved it on the working tree; the reviewed side
   * may have another module set (a target deleted or added only in the working tree) or other source roots. When the two
   * results differ, the paths that decide the difference are inputs, so the review fails instead of deciding from the
   * working tree (a false PASS, or a BLOCK the snapshot does not have).
   */
  private async pythonReference(importer: RepoPath, ref: IndexedModuleReference): Promise<void> {
    // A Python file whose content differs cannot change where an import resolves; its existence, or metadata text, can.
    const relevant = [...this.divergent.keys()].filter((p) => PY_METADATA.test(p) || (this.divergent.get(p) === "existence" && PY_RESOLUTION_FILE.test(p)));
    if (relevant.length === 0 || this.indexedFiles === undefined) return;
    this.python ??= this.pythonSides(relevant);
    const sides = await this.python;
    if (sides === undefined) return;
    const request = { fromPath: importer, specifier: ref.specifier, kind: ref.kind, language: "python" } as const;
    const worktree = resolvePython(request, sides.worktree.files, sides.worktree.roots);
    const reviewed = resolvePython(request, sides.reviewed.files, sides.reviewed.roots);
    if (resolutionKey(worktree) === resolutionKey(reviewed)) return;
    const named = [...resolutionPaths(worktree), ...resolutionPaths(reviewed)].filter((p) => this.divergent.has(p));
    // Otherwise the roots differ: a package marker or project metadata decided it.
    const decisive = named.length > 0 ? named : relevant.filter((p) => PY_METADATA.test(p) || p.endsWith("/__init__.py") || p.endsWith("setup.py"));
    for (const p of decisive.length > 0 ? decisive : relevant) this.found.add(p);
  }

  /** Both sides' Python file sets (indexed files, with the existence of differing Python files taken from each side) and roots. */
  private async pythonSides(relevant: readonly string[]): Promise<{ readonly worktree: PythonSide; readonly reviewed: PythonSide } | undefined> {
    if (this.indexedFiles === undefined) return undefined;
    const indexed = await this.indexedFiles();
    const worktreeFiles = new Set(indexed);
    const reviewedFiles = new Set(indexed);
    const reviewedMetadata = new Map<string, string | undefined>();
    for (const p of relevant) {
      const reviewedText = await this.reviewedText(p);
      if (PY_METADATA.test(p)) reviewedMetadata.set(p, reviewedText);
      if (this.divergent.get(p) !== "existence") continue;
      if ((await this.worktreeText(p)) === undefined) worktreeFiles.delete(p);
      else worktreeFiles.add(p);
      if (reviewedText === undefined) reviewedFiles.delete(p);
      else reviewedFiles.add(p);
    }
    // Root discovery reads metadata text synchronously: read every metadata file of either set first.
    const metadataText = new Map<string, string | undefined>();
    for (const p of new Set([...worktreeFiles, ...reviewedFiles])) if (PY_METADATA.test(p) && !metadataText.has(p)) metadataText.set(p, await this.worktreeText(p));
    const side = (files: ReadonlySet<string>, read: (p: string) => string | undefined): PythonSide => ({ files, roots: discoverPythonRoots(files, (p) => read(p)) });
    return {
      worktree: side(worktreeFiles, (p) => metadataText.get(p)),
      reviewed: side(reviewedFiles, (p) => (reviewedMetadata.has(p) ? reviewedMetadata.get(p) : metadataText.get(p))),
    };
  }

  /** The differing resolver configuration of files in dir (memoized per directory). */
  private configsOf(dir: string): Promise<readonly string[]> {
    const key = dir === "" ? "." : dir;
    let memo = this.configMemo.get(key);
    if (memo === undefined) { memo = this.resolverConfig(key); this.configMemo.set(key, memo); }
    return memo;
  }

  /** The nearest tsconfig.json (then jsconfig.json) and package.json from dir up to the root, as the resolver finds them. */
  private async resolverConfig(dir: string): Promise<readonly string[]> {
    const out: string[] = [];
    const join = (d: string, name: string) => (d === "." ? name : d + "/" + name);
    const dirs: string[] = [];
    for (let d = dir; ; d = path.posix.dirname(d)) { dirs.push(d); if (d === "." || d === "/" || d === "") break; }
    let configDone = false;
    let packageDone = false;
    for (const d of dirs) {
      if (!configDone) {
        for (const name of ["tsconfig.json", "jsconfig.json"]) {
          const p = join(d, name);
          if (this.divergent.get(p) === "existence") { out.push(p); continue; }
          if ((await this.worktreeText(p)) === undefined) continue;
          await this.config(p, out, 0);
          configDone = true;
          break;
        }
      }
      if (!packageDone) {
        const p = join(d, "package.json");
        if (this.divergent.get(p) === "existence") out.push(p);
        else if ((await this.worktreeText(p)) !== undefined) {
          if (this.divergent.get(p) === "content" && packageResolution(await this.reviewedText(p)) !== packageResolution(await this.worktreeText(p))) out.push(p);
          packageDone = true;
        }
      }
      if (configDone && packageDone) break;
    }
    return out;
  }

  /** A config that applies on both sides: an input when what resolution reads differs; then its in-repository extends. */
  private async config(p: string, out: string[], depth: number): Promise<void> {
    const kind = this.divergent.get(p);
    if (kind === "existence") { out.push(p); return; }
    const current = await this.worktreeText(p);
    if (kind === "content") {
      const before = configResolution(await this.reviewedText(p));
      const after = configResolution(current);
      if (before === undefined || after === undefined || before !== after) { out.push(p); return; }
    }
    if (depth >= MAX_EXTENDS) return;
    const extended = json(current)?.extends;
    for (const e of Array.isArray(extended) ? extended : extended === undefined ? [] : [extended]) {
      if (typeof e !== "string" || !(e.startsWith(".") || e.startsWith("/"))) continue;
      let target = path.posix.normalize(e.startsWith("/") ? e.slice(1) : path.posix.join(path.posix.dirname(p), e));
      if (target.startsWith("../")) continue;
      if (!target.endsWith(".json")) target += ".json";
      await this.config(target, out, depth + 1);
    }
  }
}

