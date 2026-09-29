import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { checkGraph, dumpGraph, indexRepository, openProjectGraphStore } from '@duo-director/graph';

const root = fileURLToPath(new URL('./results/local/fixtures/medium/', import.meta.url));
const output = fileURLToPath(new URL('./results/local/invariant.json', import.meta.url));
const registry = (await createDefaultAnalyzerRegistry()).value;
const store = openProjectGraphStore(root).value;
if (!registry || !store) throw new Error('run benchmark full first');
try {
  const before = dumpGraph(store);
  const start = performance.now();
  const rebuilt = await indexRepository(root, { store, registry, full: true });
  if (!rebuilt.value) throw new Error(JSON.stringify(rebuilt.diagnostics));
  const durationMs = performance.now() - start;
  const after = dumpGraph(store);
  const equal = JSON.stringify(before) === JSON.stringify(after);
  const diagnostics = checkGraph(store);
  if (!equal || diagnostics.length) throw new Error(`incremental/full graph mismatch: ${diagnostics.map((d) => d.code).join(',')}`);
  const result = { format: 'duo.benchmark-invariant/1', equal, durationMs,
    nodeCount: after.nodes.length, edgeCount: after.edges.length, structuralDiagnostics: diagnostics.length,
    fullMetrics: rebuilt.value.metrics };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Incremental == full rebuild: ${after.nodes.length} nodes, ${after.edges.length} edges`);
} finally { store.close(); registry.dispose(); }
