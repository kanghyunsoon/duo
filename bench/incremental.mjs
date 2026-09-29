// TASK-019: wall-clock of single-file (per language) and multi-file incremental index on the polyglot
// fixtures, warm (one process, reused registry) and cold (new process), plus the T08 invariant after
// each edit: the incremental graph equals a clean full rebuild of the same state.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { applyGraphPlan, buildGraphPlan, collectGraphFacts, dumpGraph, indexRepository, openNodeSqliteGraphStore, openProjectGraphStore } from '@duo-director/graph';
import { editGenerated } from './fixtures.mjs';

const local = fileURLToPath(new URL('./results/local/', import.meta.url));
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const registry = (await createDefaultAnalyzerRegistry()).value;
if (!registry) throw new Error('registry');
const out = { format: 'duo.benchmark-incremental/1', fixtures: {} };
// The T08 oracle (same as the graph tests): collect → build → apply into memory. Writes no file.
async function cleanDump(root) {
  const facts = await collectGraphFacts(root, { registry });
  if (!facts.value) throw new Error(JSON.stringify(facts.diagnostics));
  const store = openNodeSqliteGraphStore({ path: ':memory:' }).value;
  try {
    const applied = applyGraphPlan(store, buildGraphPlan(facts.value));
    if (!applied.value) throw new Error(JSON.stringify(applied.diagnostics));
    return dumpGraph(store);
  } finally { store.close(); }
}
for (const name of ['medium', 'large']) {
  const root = path.join(local, 'fixtures', name);
  if (!fs.existsSync(path.join(root, '.duo-project/generated/graph.db'))) continue;
  const rows = {};
  let ordinal = 10;
  for (const language of ['ts', 'java', 'cs', 'cpp', 'py']) {
    editGenerated(root, language, ordinal);
    const store = openProjectGraphStore(root).value;
    const t = performance.now();
    const r = await indexRepository(root, { store, registry });
    const warmMs = performance.now() - t;
    const incremental = dumpGraph(store);
    store.close();
    if (!r.value || r.value.metrics.files.analyzed !== 1) throw new Error(`${name} ${language}: ${JSON.stringify(r.diagnostics ?? r.value?.metrics.files)}`);
    const equal = JSON.stringify(incremental) === JSON.stringify(await cleanDump(root));
    if (!equal) throw new Error(`${name} ${language}: incremental graph differs from a clean rebuild`);
    editGenerated(root, language, ordinal + 1);
    const p = spawnSync(process.execPath, [worker, 'index', root], { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    if (p.status !== 0) throw new Error(p.stderr);
    const cold = JSON.parse(p.stdout);
    rows[language] = { warmMs, coldTotalMs: cold.totalMs, coldOperationMs: cold.operationMs, parsed: r.value.metrics.files.analyzed,
      modules: r.value.metrics.resolution.filesModulesRecomputed, calls: r.value.metrics.resolution.filesCallsRecomputed, scopesChanged: r.value.metrics.graph.scopesChanged, equalsCleanRebuild: equal };
  }
  for (const language of ['ts', 'java', 'cs', 'cpp', 'py']) editGenerated(root, language, ordinal + 2);
  const store = openProjectGraphStore(root).value;
  const t = performance.now();
  const multi = await indexRepository(root, { store, registry });
  const multiMs = performance.now() - t;
  const dump = dumpGraph(store);
  store.close();
  const equal = JSON.stringify(dump) === JSON.stringify(await cleanDump(root));
  if (!multi.value || multi.value.metrics.files.analyzed !== 5 || !equal) throw new Error(`${name} multi-file incremental`);
  out.fixtures[name] = { single: rows, multi: { files: 5, warmMs: multiMs, parsed: 5, equalsCleanRebuild: equal } };
  console.log(`${name}: single-file warm ${Object.values(rows).map((r) => Math.round(r.warmMs)).join('/')}ms (ts/java/cs/cpp/py), 5-file ${Math.round(multiMs)}ms; incremental == clean rebuild`);
}
registry.dispose();
fs.writeFileSync(path.join(local, 'incremental.json'), `${JSON.stringify(out, null, 2)}\n`);
