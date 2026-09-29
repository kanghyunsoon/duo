#!/usr/bin/env node
/**
 * Builds the DUO UI (T18.1): src/main.tsx → dist/app/{index.html, app.js, app.css}. One local bundle,
 * no CDN, no remote fonts, no source maps (not part of the public artifact). React is bundled; the
 * published CLI never depends on it at runtime. The server serves dist/app from memory.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist", "app");
if (path.relative(here, out).startsWith("..") || path.relative(here, out) === "") {
  throw new Error("UI build output must stay inside packages/ui");
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await build({
  absWorkingDir: here,
  entryPoints: { app: "src/main.tsx" },
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome120", "firefox120", "safari17"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
fs.writeFileSync(path.join(out, "index.html"), [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>DUO — Project Direction Console</title>",
  '<link rel="icon" href="data:,">',
  '<link rel="stylesheet" href="/assets/app.css">',
  '<script type="module" src="/assets/app.js"></script>',
  "</head>",
  '<body><div id="root"></div><noscript>The DUO UI needs JavaScript.</noscript></body>',
  "</html>",
  "",
].join("\n"));
const files = fs.readdirSync(out).map((f) => `${f} ${fs.statSync(path.join(out, f)).size} B`);
console.log(`ui: ${files.join(" · ")}`);
