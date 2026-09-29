// Release Hardening experiment: why the first `duoctl status` after a fresh install took ~18 s (T19).
// Uses only the packed tarball in isolated npm prefixes. Scenarios per round:
//   A  fresh package, existing initialized and indexed project (warm files)      → status ×3
//   B  fresh package, fresh project (created and indexed by the workspace CLI)   → status ×3
//   D  fresh package whose installed files were read once before the first run  → status ×3
// C (same package, later invocation) is the 2nd/3rd sample of A, B and D.
// A preload (--import) records Node bootstrap time (process start → user code) and the time at exit,
// so wall − exit is spawn/teardown outside the process. Nothing is added to DUO's output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixture } from '../fixtures.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const local = path.join(workspace, 'bench', 'results', 'local');
const base = path.join(local, 'first-run');
const rounds = Number(process.argv[2] ?? 3);
const pack = JSON.parse(fs.readFileSync(path.join(workspace, '.dist', 'pack.json'), 'utf8'));
const existing = path.join(local, 'fixtures', 'small');
if (!fs.existsSync(path.join(existing, '.duo-project/generated/graph.db'))) throw new Error('run pnpm benchmark:smoke first');
if (!path.resolve(base).startsWith(path.resolve(local) + path.sep)) throw new Error('unsafe base');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const preload = path.join(base, 'preload.mjs');
fs.writeFileSync(preload, "const t0 = performance.now(); process.on('exit', () => { process.stderr.write('\\nDUO_FIRST_RUN ' + JSON.stringify({ bootstrapMs: t0, exitMs: performance.now() }) + '\\n'); });\n");
const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const env = { ...process.env, OPENAI_API_KEY: '', OPENAI_BASE_URL: '', DUO_LOCALE: '' };

function install(name) {
  const prefix = path.join(base, name);
  const t = performance.now();
  const p = spawnSync(process.execPath, [npm, 'install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', pack.tarball],
    { encoding: 'utf8', windowsHide: true, env, maxBuffer: 10 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(p.stderr);
  const pkg = process.platform === 'win32' ? path.join(prefix, 'node_modules', '@duo-director', 'cli') : path.join(prefix, 'lib', 'node_modules', '@duo-director', 'cli');
  return { prefix, entry: path.join(pkg, 'dist', 'duoctl.js'), installMs: performance.now() - t };
}
function run(entry, root, extra = []) {
  const t = performance.now();
  const p = spawnSync(process.execPath, [...extra, '--import', pathToFileURL(preload).href, entry, 'status', '--root', root, '--json'],
    { cwd: root, encoding: 'utf8', windowsHide: true, env, maxBuffer: 10 * 1024 * 1024 });
  const wallMs = performance.now() - t;
  if (p.status !== 0) throw new Error(p.stderr || p.stdout);
  const m = /DUO_FIRST_RUN (\{.*\})/u.exec(p.stderr);
  const inside = m ? JSON.parse(m[1]) : {};
  const payload = JSON.parse(p.stdout);
  return { wallMs, bootstrapMs: inside.bootstrapMs, exitMs: inside.exitMs, outsideProcessMs: inside.exitMs === undefined ? undefined : wallMs - inside.exitMs,
    index: payload.index?.status ?? payload.data?.index?.status };
}
const three = (entry, root) => [run(entry, root), run(entry, root), run(entry, root)];
function readAll(dir) {
  const t = performance.now(); let bytes = 0; let files = 0;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    bytes += fs.readFileSync(path.join(e.parentPath, e.name)).length; files++;
  }
  return { ms: performance.now() - t, bytes, files };
}
function freshProject(name) {
  const root = path.join(base, name);
  makeFixture(root, 100);
  const workspaceCli = path.join(workspace, 'apps', 'cli', 'dist', 'main.js');
  const p = spawnSync(process.execPath, [workspaceCli, 'index', '--root', root], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  if (p.status !== 0) throw new Error(p.stderr);
  return root;
}
const emptyNode = () => { const t = performance.now(); spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }); return performance.now() - t; };
const result = { format: 'duo.first-run/1', os: process.platform, node: process.version, cpu: os.cpus()[0]?.model, tarball: path.basename(pack.tarball), emptyNodeMs: [emptyNode(), emptyNode(), emptyNode()], rounds: [] };
for (let r = 1; r <= rounds; r++) {
  const row = {};
  const a = install(`r${r}-A`);
  row.A = { installMs: a.installMs, runs: three(a.entry, existing) };
  const project = freshProject(`r${r}-B-project`);
  const b = install(`r${r}-B`);
  row.B = { installMs: b.installMs, runs: three(b.entry, project) };
  const d = install(`r${r}-D`);
  row.D = { installMs: d.installMs, prewarm: readAll(d.prefix), runs: three(d.entry, existing) };
  result.rounds.push(row);
  console.log(`round ${r}: A ${row.A.runs.map((x) => Math.round(x.wallMs)).join('/')} ms, B ${row.B.runs.map((x) => Math.round(x.wallMs)).join('/')} ms, D (prewarm ${Math.round(row.D.prewarm.ms)} ms) ${row.D.runs.map((x) => Math.round(x.wallMs)).join('/')} ms`);
}
// One profiled first run on a fresh package: where the JavaScript time goes.
const p = install('profile');
const profDir = path.join(base, 'prof');
result.profiled = run(p.entry, existing, ['--cpu-prof', `--cpu-prof-dir=${profDir}`]);
result.profile = fs.readdirSync(profDir).map((f) => path.join(profDir, f));
fs.writeFileSync(path.join(local, 'first-run.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`profiled first run ${Math.round(result.profiled.wallMs)} ms; wrote first-run.json`);
