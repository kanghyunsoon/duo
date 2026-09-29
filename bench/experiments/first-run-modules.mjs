// Per-module load time of the first installed `duoctl status` (fresh prefix) via a synchronous load hook.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(workspace, 'bench', 'results', 'local', 'first-run');
const pack = JSON.parse(fs.readFileSync(path.join(workspace, '.dist', 'pack.json'), 'utf8'));
const prefix = path.join(base, 'modules-' + Date.now());
const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const i = spawnSync(process.execPath, [npm, 'install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', pack.tarball], { encoding: 'utf8', windowsHide: true });
if (i.status !== 0) throw new Error(i.stderr);
const hook = path.join(base, 'module-hook.mjs');
fs.writeFileSync(hook, [
  "import { registerHooks } from 'node:module'; import fs from 'node:fs';",
  "const rows = [];",
  "registerHooks({ load(url, ctx, next) { const t = performance.now(); const r = next(url, ctx); if (url.startsWith('file:')) rows.push([url, performance.now() - t]); return r; } });",
  "process.on('exit', () => fs.writeFileSync(process.env.DUO_MODULE_LOG, JSON.stringify(rows)));",
].join('\n'));
const entry = path.join(prefix, 'node_modules', '@duo-director', 'cli', 'dist', 'duoctl.js');
const root = path.join(workspace, 'bench', 'results', 'local', 'fixtures', 'small');
const out = [];
for (const label of ['first', 'second']) {
  const logFile = path.join(base, `modules-${label}.json`);
  const t = performance.now();
  const p = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, entry, 'status', '--root', root, '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, DUO_MODULE_LOG: logFile, OPENAI_API_KEY: '' } });
  if (p.status !== 0) throw new Error(p.stderr);
  const rows = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  const pkgOf = (u) => { const s = decodeURIComponent(u).replace(/^.*node_modules\//, ''); return s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]; };
  const byPkg = {};
  for (const [u, ms] of rows) { const k = pkgOf(u); byPkg[k] = byPkg[k] ?? { files: 0, ms: 0, bytes: 0 }; byPkg[k].files++; byPkg[k].ms += ms; byPkg[k].bytes += fs.statSync(fileURLToPath(u)).size; }
  out.push({ run: label, wallMs: Math.round(performance.now() - t), modules: rows.length, loadMs: Math.round(rows.reduce((n, [, ms]) => n + ms, 0)),
    packages: Object.entries(byPkg).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => ({ package: k, files: v.files, kb: Math.round(v.bytes / 1024), ms: Math.round(v.ms) })) });
}
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(workspace, 'bench', 'results', 'local', 'first-run-modules.json'), JSON.stringify(out, null, 2) + '\n');
