import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createAnalyzerRegistry, createDefaultAnalyzerRegistry } from '@duo-director/analyzer';
import { indexRepository, openProjectGraphStore } from '@duo-director/graph';

const root = fileURLToPath(new URL('./results/local/fixtures/medium/', import.meta.url));
const output = fileURLToPath(new URL('./results/local/upgrade.json', import.meta.url));
if (!fs.existsSync(root)) throw new Error('run benchmark full first');
const base = (await createDefaultAnalyzerRegistry()).value;
if (!base) throw new Error('registry');
const upgraded = createAnalyzerRegistry(base.analyzers.map((a) => a.id === 'java'
  ? Object.create(a, { identity: { value: `${a.identity}:benchmark-upgrade`, enumerable: true } }) : a));
const store = openProjectGraphStore(root).value;
if (!store) throw new Error('graph');
try {
  const start = performance.now();
  const changed = await indexRepository(root, { store, registry: upgraded });
  if (!changed.value) throw new Error(JSON.stringify(changed.diagnostics));
  const upgradeMs = performance.now() - start;
  const languages = changed.value.metrics.languages;
  if (languages.java?.parsed !== languages.java?.files || Object.entries(languages).some(([name, row]) => name !== 'java' && row.parsed !== 0)) {
    throw new Error('analyzer identity invalidated unrelated language');
  }
  const restored = await indexRepository(root, { store, registry: base });
  if (!restored.value) throw new Error(JSON.stringify(restored.diagnostics));
  const result = { format: 'duo.benchmark-upgrade/1', syntheticIdentity: 'java + :benchmark-upgrade', upgradeMs,
    changed: changed.value.metrics, restore: restored.value.metrics };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Analyzer upgrade: ${languages.java.files} Java reparsed; other languages zero`);
} finally { store.close(); base.dispose(); }
