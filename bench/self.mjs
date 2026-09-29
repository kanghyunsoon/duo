import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { inspectIndex, openProjectGraphReader } from '@duo-director/graph';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(workspace, 'bench', 'results', 'local');
const root = path.join(output, 'fixtures', 'duo-self');
const allowed = path.resolve(output, 'fixtures') + path.sep;
if (!path.resolve(root).startsWith(allowed)) throw new Error('unsafe self fixture path');
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.dirname(root), { recursive: true });
execFileSync('git', ['clone', '-q', '--no-hardlinks', workspace, root], { windowsHide: true, stdio: 'pipe' });
// The DUO checkout has no Project Truth. For this performance-only copy, overlay the small,
// explicitly labelled context Truth fixture. It is not DUO's confirmed Project Truth.
const truth = fileURLToPath(new URL('../fixtures/context/app/.duo-project/', import.meta.url));
fs.cpSync(truth, path.join(root, '.duo-project'), { recursive: true });
fs.writeFileSync(path.join(root, '.duo-project', '.gitignore'), 'generated/\ncache/\nruntime/\n');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
function worker(kind) {
  const start = performance.now();
  const p = spawnSync(process.execPath, [path.join(workspace, 'bench', 'worker.mjs'), kind, root], { cwd: workspace,
    windowsHide: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, OPENAI_API_KEY: '' } });
  if (p.status !== 0) throw new Error(p.stderr || p.stdout);
  return { ...JSON.parse(p.stdout), parentElapsedMs: performance.now() - start };
}
const initial = worker('index');
const noop = worker('index');
const registry = (await createDefaultAnalyzerRegistry()).value;
if (!registry) throw new Error('registry');
const graph = openProjectGraphReader(root).value;
if (!graph) throw new Error('graph');
let status;
try {
  const t = performance.now();
  const inspection = await inspectIndex(root, { graph, registry });
  if (!inspection.value) throw new Error(JSON.stringify(inspection.diagnostics));
  status = { status: inspection.value.status, coverage: inspection.value.coverage, elapsedMs: performance.now() - t };
} finally { graph.close(); registry.dispose(); }
const result = { format: 'duo.benchmark-self/1', repository: 'DUO', head,
  truth: 'performance-only overlay from fixtures/context/app; this checkout has no confirmed .duo-project',
  initial, noop, status, graphDbBytes: fs.statSync(path.join(root, '.duo-project/generated/graph.db')).size,
  indexStateBytes: fs.statSync(path.join(root, '.duo-project/generated/index-state.json')).size };
fs.writeFileSync(path.join(output, 'self.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`DUO self ${head.slice(0, 8)}: ${initial.metrics.files.total} indexed files, initial ${Math.round(initial.operationMs)}ms, no-op ${Math.round(noop.operationMs)}ms`);
