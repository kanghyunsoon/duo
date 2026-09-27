/**
 * Text/binary classification (TASK-004). Deterministic and path-based: the lowercase extension or
 * file name decides, never the content. Everything not listed is binary and hashed as raw bytes.
 * Changing these lists changes contentHash values, so it requires a new FINGERPRINT_FORMAT_VERSION.
 */
import type { RepoPath } from "@duo-director/core";

export type FileContentKind = "text" | "binary";

/** Extensions (lowercase, without the dot) of files handled as text. */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** Whole file names (lowercase) handled as text regardless of extension. */
export const TEXT_FILE_NAMES: ReadonlySet<string> = new Set([
  ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".node-version",
  ".prettierrc", ".prettierignore", ".eslintrc", ".eslintignore", ".dockerignore", ".browserslistrc", ".babelrc",
  "makefile", "dockerfile", "license", "licence", "readme", "changelog", "notice", "authors", "contributors",
  "codeowners", "procfile", "gemfile", "rakefile", "vagrantfile", "jenkinsfile",
]);

export function classifyContentKind(path: RepoPath): FileContentKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (TEXT_FILE_NAMES.has(name)) return "text";
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_FILE_EXTENSIONS.has(name.slice(dot + 1)) ? "text" : "binary";
}
