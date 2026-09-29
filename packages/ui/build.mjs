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
const result = await build({
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
  metafile: true,
  logLevel: "warning",
});

// Third-party code inside app.js (React, react-dom, scheduler …). legalComments is "none", so their
// license texts travel as data: dist/licenses.json, which pack-cli turns into THIRD_PARTY_NOTICES.md.
// Outside dist/app on purpose: the server serves only the allowlisted app files.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const normalized = input.replaceAll("\\", "/");
  const at = normalized.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const rest = normalized.slice(at + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = path.join(here, normalized.slice(0, at + "node_modules/".length) + name);
  if (packages.has(name)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(?:LICEN[CS]E|COPYING)(?:\.|$)/iu.test(f));
  if (licenseFile === undefined) throw new Error(`${name} is bundled into the UI but ships no LICENSE file`);
  packages.set(name, { name, version: meta.version, license: meta.license, text: fs.readFileSync(path.join(dir, licenseFile), "utf8") });
}
const licenses = [...packages.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
fs.writeFileSync(path.join(here, "dist", "licenses.json"), `${JSON.stringify({ format: "duo.ui-licenses/1", packages: licenses }, null, 2)}\n`);
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
