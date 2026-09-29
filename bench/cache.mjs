import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { compileContext } from '@duo-director/director';
import { indexRepository, openProjectGraphStore } from '@duo-director/graph';

const root = fileURLToPath(new URL('./results/local/fixtures/small/', import.meta.url));
const output = fileURLToPath(new URL('./results/local/cache.json', import.meta.url));
if (!fs.existsSync(path.join(root, '.duo-project/generated/graph.db'))) throw new Error('run benchmark:smoke first');
const packetCache = path.resolve(root, '.duo-project', 'cache', 'packets');
if (!packetCache.startsWith(path.resolve(root, '.duo-project', 'cache') + path.sep)) throw new Error('unsafe packet cache path');
if (fs.existsSync(packetCache)) fs.rmSync(packetCache, { recursive: true, force: true });
const registry = (await createDefaultAnalyzerRegistry()).value;
if (!registry) throw new Error('registry');
const store = openProjectGraphStore(root).value;
if (!store) throw new Error('graph');
const context = async (budget) => {
  const t = performance.now();
  const r = await compileContext(root, { task: 'AUTH-03', ...(budget === undefined ? {} : { budget }) }, { graph: store, registry, cache: true });
  if (!r.value || r.value.status !== 'ready') throw new Error(`context: ${JSON.stringify(r.diagnostics ?? r.value?.status)}`);
  return { cache: r.value.cache.status, digest: r.value.packet.dependencyDigest, ms: performance.now() - t };
};
const index = async () => { const r = await indexRepository(root, { store, registry }); if (!r.value) throw new Error(JSON.stringify(r.diagnostics)); };
const replace = (file, before, after) => {
  const target = path.join(root, file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(before)) throw new Error(`fixture text changed: ${file}`);
  fs.writeFileSync(target, original.replace(before, after));
};
try {
  await index();
  const first = await context();
  const same = await context();
  replace('src/game/physics.ts', 'Minimal 2D physics', 'Benchmark 2D physics');
  await index();
  const unrelated = await context();
  replace('.duo-project/specs/auth.md', 'Access tokens live 15 minutes', 'Access tokens live 10 minutes');
  await index();
  const requirement = await context();
  replace('src/auth/AuthService.ts', 'unknown refresh token', 'refresh token not found');
  await index();
  const symbol = await context();
  const budget = await context(5000);
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(same.cache === 'hit', 'same request must hit');
  assert(unrelated.cache === 'hit' && unrelated.digest === same.digest, 'unrelated file should retain dependency digest');
  assert(requirement.cache === 'miss' && requirement.digest !== unrelated.digest, 'Requirement change must invalidate');
  assert(symbol.cache === 'miss' && symbol.digest !== requirement.digest, 'Symbol change must invalidate');
  assert(budget.cache === 'miss' && budget.digest !== symbol.digest, 'budget change must invalidate');
  const result = { format: 'duo.benchmark-cache/1', first, same, unrelated, requirement, symbol, budget };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log('Context cache dependency regression: OK');
} finally { store.close(); registry.dispose(); }
