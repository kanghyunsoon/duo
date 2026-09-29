import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(workspace, 'bench', 'results', 'local');
const prefix = path.join(local, 'packed-prefix');
const fixture = path.join(local, 'fixtures', 'small');
if (!fs.existsSync(path.join(fixture, '.duo-project/generated/graph.db'))) throw new Error('run benchmark:smoke first');
if (!path.resolve(prefix).startsWith(path.resolve(local) + path.sep)) throw new Error('unsafe install prefix');
if (fs.existsSync(prefix)) fs.rmSync(prefix, { recursive: true, force: true });
execFileSync('node', [path.join(workspace, 'scripts', 'pack-cli.mjs')], { cwd: workspace, stdio: 'pipe', windowsHide: true });
const pack = JSON.parse(fs.readFileSync(path.join(workspace, '.dist', 'pack.json'), 'utf8'));
const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const install = fs.existsSync(npm) ? [process.execPath, [npm]] : ['npm', []];
const installed = spawnSync(install[0], [...install[1], 'install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', pack.tarball],
  { cwd: local, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
if (installed.status !== 0) throw new Error(`packed install: ${installed.stderr}`);
const packedEntry = path.join(prefix, 'node_modules', '@duo-director', 'cli', 'dist', 'duoctl.js');
const workspaceEntry = path.join(workspace, 'apps', 'cli', 'dist', 'main.js');
function sample(entry, command, args = []) {
  const start = performance.now();
  const p = spawnSync(process.execPath, [entry, command, '--root', fixture, '--json', ...args],
    { cwd: fixture, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, OPENAI_API_KEY: '', OPENAI_BASE_URL: '', NODE_PATH: '' } });
  if (p.status !== 0) throw new Error(`${entry} ${command}: ${p.stderr || p.stdout}`);
  return { elapsedMs: performance.now() - start, output: JSON.parse(p.stdout) };
}
const rows = {};
// The deterministic part of each payload: status format, Packet digest, Review verdict and claims.
const identity = (command, o) => JSON.stringify(command === 'status' ? { format: o.format, index: o.index?.status, analysis: o.analysis?.files }
  : command === 'context' ? { format: o.format, status: o.status, digest: o.context?.packet?.dependencyDigest }
    : { format: o.format, status: o.status, verdict: o.verdict, claims: o.claims?.map((c) => c.id), evidence: o.evidence?.map((e) => e.id) });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [command, args] of [['status', []], ['context', ['AUTH-03']], ['review', []]]) {
  const firstPacked = sample(packedEntry, command, args); // first run of freshly installed files
  const ws = []; const pk = [];
  for (let i = 0; i < 3; i++) { ws.push(sample(workspaceEntry, command, args)); pk.push(sample(packedEntry, command, args)); }
  const a = identity(command, ws[0].output); const b = identity(command, pk[0].output);
  if (a !== b || identity(command, firstPacked.output) !== a) throw new Error(`${command}: workspace and packed results differ: ${a} vs ${b}`);
  rows[command] = { firstPackedMs: firstPacked.elapsedMs, workspaceMedianMs: median(ws.map((r) => r.elapsedMs)), packedMedianMs: median(pk.map((r) => r.elapsedMs)), n: 3, identical: true };
}
const result = { format: 'duo.benchmark-packed/1', tarballBytes: pack.size, unpackedBytes: pack.unpackedSize,
  packageFiles: pack.entryCount, installPrefix: prefix, rows };
fs.writeFileSync(path.join(local, 'packed.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Packed distribution: ${Object.entries(rows).map(([k, r]) => `${k} workspace ${Math.round(r.workspaceMedianMs)}ms / packed ${Math.round(r.packedMedianMs)}ms`).join(', ')}; deterministic results identical`);
