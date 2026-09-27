/**
 * Fingerprint mode (TASK-004, C37). How contentHash treats a file's bytes; it does not claim a MIME
 * or content type, and it is independent of language support (a LanguageAnalyzer decides that).
 *
 * - "normalized-text": CRLF → LF, then SHA-256. Listed extensions and file names only.
 * - "raw": bytes unchanged, then SHA-256. Every other file, including text files with an
 *   unlisted extension: for those the hash follows the checkout's line endings.
 *
 * Path-based and deterministic: the lowercase extension or file name decides, never the content.
 * Changing these lists changes contentHash values and requires a new FINGERPRINT_FORMAT_VERSION.
 */
import type { RepoPath } from "@duo-director/core";

export type FingerprintMode = "normalized-text" | "raw";

/** Extensions (lowercase, without the dot) fingerprinted as normalized text. Includes every supported source and Project Truth extension. */
export const NORMALIZED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // TypeScript / JavaScript and web
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "svg", "hbs", "ejs", "njk", "liquid",
  // data and configuration
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "xml", "csv", "tsv", "lock",
  "graphql", "gql", "proto", "sql", "tf", "hcl",
  // documentation
  "md", "markdown", "mdx", "txt", "rst", "adoc", "tex", "bib",
  // other languages and scripts
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "groovy", "gradle", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "cs", "fs", "swift", "m", "mm", "php", "pl", "lua", "r", "dart", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "diff", "patch",
]);

/** Whole file names (lowercase) fingerprinted as normalized text regardless of extension. */
export const NORMALIZED_TEXT_FILE_NAMES: ReadonlySet<string> = new Set([
  ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".node-version",
  ".prettierrc", ".prettierignore", ".eslintrc", ".eslintignore", ".dockerignore", ".browserslistrc", ".babelrc",
  "makefile", "dockerfile", "license", "licence", "readme", "changelog", "notice", "authors", "contributors",
  "codeowners", "procfile", "gemfile", "rakefile", "vagrantfile", "jenkinsfile",
]);

export function fingerprintModeOf(path: RepoPath): FingerprintMode {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NORMALIZED_TEXT_FILE_NAMES.has(name)) return "normalized-text";
  const dot = name.lastIndexOf(".");
  return dot > 0 && NORMALIZED_TEXT_EXTENSIONS.has(name.slice(dot + 1)) ? "normalized-text" : "raw";
}
