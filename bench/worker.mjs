import { performance } from 'node:perf_hooks';

// Invoked in a fresh Node process. The first sample includes ESM module loading and WASM setup.
const [kind, root, arg] = process.argv.slice(2);
const start = performance.now();
const analyzer = await import('@duo-director/analyzer');
const graph = await import('@duo-director/graph');
const director = await import('@duo-director/director');
// Loaded like the CLI does (the whole surface), so modulesMs is the CLI's module cost; not called here.
await import('@duo-director/integration');
const modulesMs = performance.now() - start;
const rss = () => ({ rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed });
const requireValue = (r, what) => {
  if (r?.value === undefined) throw new Error(`${what}: ${JSON.stringify(r?.diagnostics ?? [])}`);
  return r.value;
};
let result;
if (kind === 'grammar') {
  const t = performance.now();
  const set = requireValue(await analyzer.loadGrammarSet([arg]), 'grammar');
  result = { kind, grammar: arg, loadMs: performance.now() - t, memory: rss() };
  set.dispose?.();
} else if (kind === 'grammars-all') {
  const t = performance.now();
  const registry = requireValue(await analyzer.createDefaultAnalyzerRegistry(), 'registry');
  result = { kind, loadMs: performance.now() - t, memory: rss(), digest: registry.digest() };
  registry.dispose();
} else {
  const tRegistry = performance.now();
  const registry = requireValue(await analyzer.createDefaultAnalyzerRegistry(), 'registry');
  const registryMs = performance.now() - tRegistry;
  const tOpen = performance.now();
  const store = requireValue(kind === 'index' ? graph.openProjectGraphStore(root) : graph.openProjectGraphReader(root), 'store');
  const sqliteOpenMs = performance.now() - tOpen;
  const phases = {};
  const t = performance.now();
  try {
    if (kind === 'index') {
      const r = requireValue(await graph.indexRepository(root, { store, registry, onPhase: (name, ms) => { phases[name] = ms; } }), 'index');
      result = { kind, metrics: r.metrics, phases, operationMs: performance.now() - t };
    } else if (kind === 'status') {
      const r = requireValue(await graph.inspectIndex(root, { graph: store, registry, onPhase: (name, ms) => { phases[name] = ms; } }), 'status');
      result = { kind, status: r.status, coverage: r.coverage, wouldRebuild: r.wouldRebuild, phases, operationMs: performance.now() - t };
    } else if (kind === 'context') {
      const r = requireValue(await director.compileContext(root, { task: arg ?? 'AUTH-03' }, { graph: store, registry, cache: true }), 'context');
      result = { kind, status: r.status, metrics: r.metrics, performance: r.performance, cache: r.cache, packet: r.packet, operationMs: performance.now() - t };
    } else if (kind === 'review') {
      const r = requireValue(await director.reviewChanges(root, { task: arg ?? 'AUTH-03', diff: { from: 'HEAD', to: 'WORKTREE' } }, { graph: store, registry }), 'review');
      result = { kind, verdict: r.result.verdict, metrics: r.result.metrics, performance: r.performance, operationMs: performance.now() - t };
    } else if (kind === 'init-plan') {
      const r = requireValue(await director.planInit(root), 'init plan');
      result = { kind, state: r.state, operationMs: performance.now() - t };
    } else throw new Error(`unknown benchmark worker operation: ${kind}`);
  } finally { store.close(); registry.dispose(); }
  result.registryMs = registryMs;
  result.sqliteOpenMs = sqliteOpenMs;
  result.memory = rss();
}
result.modulesMs = modulesMs;
result.totalMs = performance.now() - start;
process.stdout.write(`${JSON.stringify(result)}\n`);
